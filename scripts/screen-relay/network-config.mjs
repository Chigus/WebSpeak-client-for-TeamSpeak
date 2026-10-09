// Runs in a network-isolated helper container with host networking but no Docker
// socket. /runtime contains the private node configuration, never source control.
import dgram from 'node:dgram';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
const root = '/runtime';
const config = JSON.parse(await readFile(`${root}/node.json`, 'utf8'));
if (!isIPv4(config.lanIp) || !isIPv4(config.gateway) || !/^[a-z0-9.-]+$/.test(config.realm)
    || !/^[a-f0-9]{64}$/.test(config.secret)) throw new Error('Invalid private node configuration');
const xmlEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlText = (xml, key) => xml.match(new RegExp(`<${key}[^>]*>([^<]*)</${key}>`))?.[1]?.replace(/&amp;/g, '&');

async function discover() {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, location) => { if (done) return; done = true; clearTimeout(timer); clearInterval(retry); socket.close(); error ? reject(error) : resolve(location); };
    const timer = setTimeout(() => finish(new Error('Gateway UPnP discovery timed out')), 8000);
    const packet = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
    const send = () => socket.send(packet, 1900, config.gateway);
    const retry = setInterval(send, 1500);
    socket.on('error', error => finish(error));
    socket.on('message', (data, remote) => {
      if (remote.address !== config.gateway) return;
      const location = data.toString().match(/^location:\s*(\S+)/im)?.[1];
      if (location && new URL(location).hostname === config.gateway) finish(null, location);
    });
    socket.bind(0, config.lanIp, send);
  });
}
async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}
const location = await discover();
const description = await (await request(location)).text();
const services = description.match(/<service>\s*[\s\S]*?<\/service>/g) ?? [];
const service = services.find(value => /:WANIPConnection:/.test(value));
if (!service) throw new Error('Gateway does not advertise WANIPConnection');
const type = xmlText(service, 'serviceType'), control = new URL(xmlText(service, 'controlURL'), location);
if (control.hostname !== config.gateway) throw new Error('Unexpected gateway control address');
async function soap(action, fields = {}) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${Object.entries(fields).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const result = await request(control, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#${action}"` }, body });
  const text = await result.text();
  return { ok: result.ok, text, code: xmlText(text, 'errorCode') };
}
const external = await soap('GetExternalIPAddress');
const publicIp = xmlText(external.text, 'NewExternalIPAddress');
if (!external.ok || !isIPv4(publicIp) || /^(0|10|127|192\.168|169\.254)\./.test(publicIp)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(publicIp) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(publicIp)) throw new Error('Gateway has no usable public IPv4');
const mappings = [{ port: 3478, protocol: 'TCP' }, { port: 3478, protocol: 'UDP' }, ...Array.from({ length: 100 }, (_, i) => ({ port: 49160 + i, protocol: 'UDP' }))];
let restored = 0;
for (const { port, protocol } of mappings) {
  const fields = { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol };
  const current = await soap('GetSpecificPortMappingEntry', fields);
  if (current.ok) {
    if (xmlText(current.text, 'NewInternalClient') !== config.lanIp || Number(xmlText(current.text, 'NewInternalPort')) !== port || xmlText(current.text, 'NewEnabled') !== '1') throw new Error(`Port mapping conflict: ${protocol} ${port}`);
  } else {
    if (current.code !== '714') throw new Error(`Cannot inspect mapping: ${protocol} ${port}`);
    const added = await soap('AddPortMapping', { ...fields, NewInternalPort: port, NewInternalClient: config.lanIp, NewEnabled: 1, NewPortMappingDescription: 'WebSpeak-Screen', NewLeaseDuration: 0 });
    if (!added.ok) throw new Error(`Cannot restore mapping: ${protocol} ${port}`);
    restored++;
  }
}
const contents = `listening-port=3478
listening-ip=${config.lanIp}
relay-ip=${config.lanIp}
external-ip=${publicIp}/${config.lanIp}
min-port=49160
max-port=49259
realm=${config.realm}
server-name=${config.realm}
fingerprint
use-auth-secret
static-auth-secret=${config.secret}
stale-nonce=600
user-quota=12
total-quota=100
max-bps=3000000
bps-capacity=30000000
no-tcp-relay
no-multicast-peers
no-cli
no-tls
no-dtls
no-software-attribute
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
log-file=stdout
simple-log
pidfile=/tmp/turnserver.pid
`;
await mkdir(`${root}/coturn`, { mode: 0o755, recursive: true });
const previous = await readFile(`${root}/coturn/turnserver.conf`, 'utf8').catch(() => '');
const changed = previous !== contents;
if (changed) {
  await writeFile(`${root}/coturn/turnserver.conf.next`, contents, { mode: 0o644 });
  await rename(`${root}/coturn/turnserver.conf.next`, `${root}/coturn/turnserver.conf`);
}
await writeFile(`${root}/network-state.json`, JSON.stringify({ publicIp, checkedAt: new Date().toISOString(), restored, changed }) + '\n', { mode: 0o644 });
console.log(JSON.stringify({ publicIp, restored, changed }));
