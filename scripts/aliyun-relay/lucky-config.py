#!/usr/bin/env python3
"""Lucky 2.27.2 API configuration. Credentials and live config stay outside Git."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path('/opt/webspeak-aliyun-relay')
STATE = Path('/var/lib/webspeak-lucky')
HOST = 'aliyun.narcissu1.top'
UPSTREAM = '2.narcissu1.top'
BIN = '/usr/local/lib/webspeak-lucky/2.27.2/lucky'


class API:
    def __init__(self, base='http://127.0.0.1:16602/', credentials=None):
        self.base = base
        self.token = None
        if credentials:
            self.base += credentials['SafeURL'].strip('/') + '/'
            self.login(credentials)

    def call(self, path, method='GET', data=None, **params):
        # Lucky's frontend request timestamp includes a mod-8 checksum.
        stamp = str(int(time.time() * 1000))[:-1]
        params['_'] = stamp + str(sum(map(int, stamp)) % 8)
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Lucky-Admin-Token'] = self.token
        req = Request(self.base + path.lstrip('/') + '?' + urlencode(params),
                      data=None if data is None else json.dumps(data).encode(),
                      headers=headers, method=method)
        with urlopen(req, timeout=20) as response:
            result = json.load(response)
        if result.get('ret') != 0:
            raise RuntimeError(f'{method} {path}: {result.get("ret")} {result.get("msg", "")}')
        return result

    def login(self, credentials):
        self.token = self.call('api/login', 'POST', {
            'Account': credentials['Account'], 'Password': credentials['Password'],
            'TwoFA': ''})['token']


def bootstrap():
    """Must run in a new network namespace with only its loopback brought up."""
    if os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise RuntimeError('Bootstrap requires an isolated network namespace')
    if (ROOT / 'lucky-admin.json').exists() or (STATE / 'conf/lucky_base.lkcf').exists():
        raise RuntimeError('Refusing to replace existing Lucky credentials/configuration')
    (STATE / 'conf').mkdir(mode=0o700, parents=True, exist_ok=True)
    process = subprocess.Popen([BIN, '-cd', str(STATE / 'conf'), '-ds'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        api = API(base='http://127.0.0.1:16601/')
        for attempt in range(30):
            try:
                api.login({'Account': '666', 'Password': '666'})
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('Isolated Lucky did not start')
        conf = api.call('api/baseconfigure')['baseconfigure']
        credentials = {'Account': 'lucky-admin', 'Password': secrets.token_urlsafe(30),
                       'SafeURL': secrets.token_urlsafe(24)}
        # Lucky opens the new socket before closing the old wildcard listener.
        # Change the port as well as the address to avoid Linux EADDRINUSE.
        conf.update(AdminWebListenIP='127.0.0.1', AdminWebListenPort=16602,
                    AdminWebListenTLS=False, AdminAccount=credentials['Account'],
                    AdminPassword=credentials['Password'], SafeURL=credentials['SafeURL'],
                    AllowInternetaccess=False, EnableOpenToken=False,
                    GlobalDisableFirewallOpt=True, AutoOptionsFirewall=False,
                    InsecureSkipVerify=False, DisableAllowAllOrigins=True,
                    OriginsList='', TimeZone='Asia/Shanghai')
        api.call('api/baseconfigure', 'PUT', conf)
        path = ROOT / 'lucky-admin.json'
        with path.open('x') as out:
            os.chmod(path, 0o600)
            json.dump(credentials, out)
        time.sleep(1)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def certificate_snapshot():
    source = ROOT / 'acme/live' / HOST
    cert = (source / 'fullchain.pem').read_bytes()
    key = (source / 'privkey.pem').read_bytes()
    def openssl(args, data):
        return subprocess.check_output(['openssl', *args], input=data, stderr=subprocess.DEVNULL)
    openssl(['x509', '-noout', '-checkend', '86400'], cert)
    if openssl(['x509', '-pubkey', '-noout'], cert) != openssl(['pkey', '-pubout'], key):
        raise RuntimeError('Certificate and private key do not match')
    if b'does match certificate' not in openssl(['x509', '-noout', '-checkhost', HOST], cert):
        raise RuntimeError('Certificate hostname does not match')
    folder = STATE / 'certs'
    folder.mkdir(mode=0o750, exist_ok=True)
    generation = hashlib.sha256(cert + key).hexdigest()
    target = folder / generation
    target.mkdir(mode=0o750, exist_ok=True)
    import grp
    gid = grp.getgrnam('webspeak-lucky').gr_gid
    for name, data in [('fullchain.pem', cert), ('privkey.pem', key)]:
        path = target / name
        path.write_bytes(data)
        os.chmod(path, 0o640)
        os.chown(path, 0, gid)
    os.chown(folder, 0, gid)
    os.chown(target, 0, gid)
    # Deployment uses umask 077; mkdir(mode=0750) alone would produce 0700.
    # The daemon needs group traversal, while only root can replace certificates.
    os.chmod(folder, 0o750)
    os.chmod(target, 0o750)
    link = folder / 'current.new'
    link.unlink(missing_ok=True)
    link.symlink_to(generation, target_is_directory=True)
    link.replace(folder / 'current')


def port_rule(name, port, target, protocols, tls=False):
    return dict(Name=name, Key='', DiaglogShowMode='diy', ListenAddress='0.0.0.0',
                ListenPorts=str(port), TargetAddressList=[UPSTREAM], TargetPorts=str(target),
                ForwardTypes=protocols, Enable=True, LogLevel=3, LogOutputToConsole=False,
                OpenFirewallPorts=False, AccessLogMaxNum=128, WebListShowLastLogMaxCount=10,
                Options=dict(DisableSelfForwardingCheck=False, SingleProxyMaxTCPConnections=512,
                             SingleProxyMaxUDPReadTargetDatagoroutineCount=32,
                             UDPSessionTimeout=30000, UDPPacketSize=65535,
                             SafeMode='blacklist', TCPListenTLS=tls, TCPRelayTLS=False,
                             TCPRelayTLSInsecureSkipVerify=False))


def web_rule():
    proxy = dict(Key='', Enable=True, Remark='WebSpeak via Shenzhen to Macau',
                 WebServiceType='reverseproxy', Domains=[HOST],
                 Locations=[f'https://{UPSTREAM}:5555'], LocationInsecureSkipVerify=False,
                 UseTargetHost=False, DisableLongConnection=False, DisableKeepAlives=False,
                 HttpClientNetwork='tcp4', HttpClientTimeout=0, EnableAccessLog=True,
                 LogLevel=3, LogOutputToConsole=False, AccessLogMaxNum=128,
                 WebListShowLastLogMaxCount=10, EnableBasicAuth=False,
                 EnableCrossDomain=False, EasyLucky=False, CacheEnabled=False,
                 AddRemoteIPToHeader=True, AddRemoteIPHeaderKey='X-Forwarded-For',
                 AddProtoToHeader=True, ProtoHeaderKey='X-Forwarded-Proto',
                 SafeIPMode='blacklist', SafeUserAgentMode='blacklist',
                 UserAgentfilter=[], FileServerMountList=[], OtherParams={})
    return dict(RuleName='WebSpeak HTTPS / WSS via Shenzhen', RuleKey='',
                DiaglogShowMode='diy', Enable=True, Network='tcp4', ListenIP='0.0.0.0',
                ListenPort=5555, AutoOptionsFirewall=False, EnableTLS=True,
                TLSMinVersion=2, MaxHeaderKBytes=32, IPFilterRule='disable', Http3=False,
                DefaultProxy=dict(Key='default', WebServiceType='reverseproxy', Locations=[],
                                  LocationInsecureSkipVerify=False, EnableAccessLog=True,
                                  AccessLogMaxNum=64, LogLevel=3), ProxyList=[proxy])


def configure(api):
    base = api.call('api/baseconfigure')['baseconfigure']
    if (base.get('AdminWebListenIP') != '127.0.0.1' or base.get('AllowInternetaccess')
            or base.get('AdminPassword') == '666' or not base.get('SafeURL')):
        raise RuntimeError('Lucky management isolation/authentication check failed')
    # First installation only: refuse to overwrite rules made through the Lucky UI.
    ports = api.call('api/portforwards')
    web = api.call('api/webservice/rules')
    if any(ports.get(k) for k in ['list', 'ruleList', 'rules']) or any(
            web.get(k) for k in ['list', 'ruleList', 'rules']):
        raise RuntimeError('Lucky already has rules; review them instead of replacing')
    result = api.call('api/ssl', 'POST', dict(
        Key='', Enable=True, Remark=HOST, AddFrom='path', CertBase64='', KeyBase64='',
        MappingToPath=False, AllSyncClient=False, SyncClientList=[],
        ExtParams={'certPath': str(STATE / 'certs/current/fullchain.pem'),
                   'keyPath': str(STATE / 'certs/current/privkey.pem')}))
    print('Lucky certificate configured.', flush=True)
    api.call('api/webservice/rules', 'POST', web_rule())
    for rule in [port_rule('WebSpeak TURN UDP / TCP via Shenzhen', 33478, 33478, ['tcp4', 'udp4']),
                 port_rule('WebSpeak TURN TLS via Shenzhen', 5349, 33478, ['tcp4'], True),
                 port_rule('Native TeamSpeak UDP via Shenzhen', 9987, 9988, ['udp4'])]:
        api.call('api/portforward', 'POST', rule)
    print('Lucky HTTPS/WSS and three port-forward rules configured.', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['bootstrap', 'configure', 'renew', 'status'])
    args = parser.parse_args()
    if args.action == 'bootstrap':
        bootstrap()
        return
    api = API(credentials=json.loads((ROOT / 'lucky-admin.json').read_text()))
    if args.action in ['configure', 'renew']:
        certificate_snapshot()
    if args.action == 'configure':
        configure(api)
    elif args.action == 'renew':
        # Path certificates also reload daily inside Lucky. Refresh after renewal now.
        matches = [item for item in api.call('api/ssl').get('list', [])
                   if item.get('Remark') == HOST and item.get('AddFrom') == 'path']
        if len(matches) != 1:
            raise RuntimeError('Expected one managed path certificate')
        api.call('api/ssl/flush', 'PUT', key=matches[0]['Key'])
        print('Lucky certificate snapshot refreshed.')
    else:
        for path in ['api/portforwards', 'api/webservice/rules_lite']:
            print(json.dumps(api.call(path), ensure_ascii=False))


if __name__ == '__main__':
    main()
