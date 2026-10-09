#!/usr/bin/env python3
"""Add only the owner's Aliyun wildcard A record; keep other DNS records intact."""
import configparser
import json
from pathlib import Path
import urllib.error
from urllib.request import Request, urlopen

ROOT = Path('/opt/webspeak-aliyun-relay')
NAME = '*.aliyun.narcissu1.top'
IP = '39.108.235.140'


def main():
    settings = configparser.ConfigParser(interpolation=None)
    settings.read_string('[cf]\n' + (ROOT / 'credentials/cloudflare.ini').read_text())
    token = settings['cf']['dns_cloudflare_api_token']

    def api(path, method='GET', payload=None):
        req = Request('https://api.cloudflare.com/client/v4' + path, method=method,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                      data=None if payload is None else json.dumps(payload).encode())
        try:
            with urlopen(req, timeout=25) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError('Cloudflare HTTP ' + str(error.code)) from None
        if not result.get('success'):
            raise RuntimeError('Cloudflare did not confirm success')
        return result['result']

    zones = api('/zones?name=narcissu1.top')
    if len(zones) != 1:
        raise RuntimeError('Expected one authorized zone')
    records = '/zones/' + zones[0]['id'] + '/dns_records'
    path = records + '?name=%2A.aliyun.narcissu1.top'
    old = api(path)
    if old:
        if len(old) != 1 or any(old[0].get(k) != v for k, v in
                               {'type': 'A', 'content': IP, 'proxied': False}.items()):
            raise RuntimeError('Existing wildcard differs; review before changing')
    else:
        api(records, 'POST', {'type': 'A', 'name': NAME, 'content': IP, 'proxied': False,
                             'ttl': 1, 'comment': 'Lucky public services on Aliyun'})
    confirmed = api(path)
    if len(confirmed) != 1 or confirmed[0]['content'] != IP or confirmed[0]['proxied']:
        raise RuntimeError('Wildcard DNS verification failed')
    print(json.dumps({k: confirmed[0][k] for k in ['type', 'name', 'content', 'proxied', 'ttl']}))


if __name__ == '__main__':
    main()
