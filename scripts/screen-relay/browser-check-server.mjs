// Manual synthetic acceptance harness. Never captures a real screen/microphone.
// Requires a separately created, password-protected, empty test channel.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createServer } = createRequire(path.join(root, 'web/package.json'))('vite');
const gateway = new URL(process.env.SCREEN_TEST_GATEWAY);
if (gateway.protocol !== 'https:') throw new Error('HTTPS gateway required');
const room = JSON.parse(await readFile(process.env.SCREEN_TEST_ROOM, 'utf8'));
if (!room.ownedByThisTask || !room.channelPassword) throw new Error('Owned protected test room required');
const origin = 'http://127.0.0.1:8848';
const suffix = randomBytes(4).toString('hex');
const fixture = { name: 'screen-relay-acceptance', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url === '/screen-relay-check') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>WebSpeak 屏幕共享线路验收</title><style>body{font:16px system-ui;background:#f1f7f7;color:#143c3c;margin:32px}button{font:inherit;padding:12px 22px}video{width:48%;background:#142a2a}pre{white-space:pre-wrap}</style><h1>屏幕共享线路验收</h1><p>真实公网信令与媒体传输；测试画布和合成音频，无物理屏幕或麦克风采集。</p><button id="start">开始五条媒体路径测试</button><p id="state">等待开始</p><video id="preview" muted autoplay playsinline></video><video id="remote" muted autoplay playsinline></video><pre id="result"></pre><script type="module" src="/screen-relay-check.mjs"></script></html>');
    } else if (req.url === '/screen-relay-check.mjs') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path.join(root, 'scripts/screen-relay/browser-check.mjs')));
    } else if (req.url === '/screen-relay-check/report' && req.method === 'POST' && req.headers.origin === origin) {
      let body = ''; for await (const part of req) { body += part; if (body.length > 65536) { res.writeHead(413); res.end(); return; } }
      const report = JSON.parse(body);
      await writeFile(process.env.SCREEN_TEST_REPORT, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ status: report.status, tests: report.cases?.length, error: report.error }));
      res.end('ok');
    } else next();
  });
} };
const vite = await createServer({ configFile: false, root: path.join(root, 'web'), plugins: [fixture], server: { host: '127.0.0.1', port: 8848, strictPort: true, fs: { allow: [root] } } });
await vite.listen();
const wss = new WebSocketServer({ noServer: true });
vite.httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/screen-relay-check/ws' && req.headers.origin === origin) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
let count = 0;
wss.on('connection', async local => {
  const id = count++;
  if (id >= 2) { local.close(); return; }
  let remote;
  local.on('close', () => remote?.close());
  try {
    const response = await fetch(new URL('/api/join-ticket', gateway), { method: 'POST', headers: { 'Content-Type': 'application/json', origin: gateway.origin }, body: JSON.stringify({ nickname: `Screen-Test-${id}-${suffix}`, rememberIdentity: false }), signal: AbortSignal.timeout(15000) });
    if (response.status !== 201) throw new Error('Ticket rejected');
    const ticket = await response.json();
    const url = new URL('/ws/voice', gateway); url.protocol = 'wss:'; url.searchParams.set('ticket', ticket.ticket);
    remote = new WebSocket(url, { origin: gateway.origin, handshakeTimeout: 15000, perMessageDeflate: false });
    let connected, joined = false;
    remote.on('message', (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw.toString());
      if (message.type === 'connected') {
        connected = message;
        remote.send(JSON.stringify({ type: 'switchChannel', requestId: 'screen-test-room', payload: { channelId: String(room.channelId), password: room.channelPassword } }));
        return;
      }
      if (message.type === 'channelSwitched') {
        if (String(message.channelId) !== String(room.channelId)) { local.close(); remote.close(); return; }
        joined = true; local.send(JSON.stringify(connected));
      }
      if (joined && local.readyState === 1) local.send(raw.toString());
    });
    remote.on('error', () => local.close()); remote.on('close', () => local.close());
    local.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (joined && message.type?.startsWith('screenShare') && remote.readyState === 1) remote.send(raw.toString());
    });
  } catch { local.close(); }
});
console.log('Synthetic acceptance harness ready: '+origin+'/screen-relay-check');
