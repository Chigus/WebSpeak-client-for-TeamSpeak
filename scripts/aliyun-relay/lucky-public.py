#!/usr/bin/env python3
"""Opt-in public Lucky HTTPS and shared service ingress; preserve existing rules."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('lucky_config', Path(__file__).with_name('lucky-config.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


def rules():
    result = []
    for port, domains, name in [
        (16601, [config.HOST], 'Lucky public HTTPS administration'),
        (20195, ['lucky.' + config.HOST], 'Aliyun public HTTPS services'),
    ]:
        rule = config.web_rule()
        rule.update(RuleName=name, ListenPort=port)
        proxy = rule['ProxyList'][0]
        proxy.update(Remark='Lucky administration with existing authentication',
                     Domains=domains, Locations=['http://127.0.0.1:16602'],
                     EasyLucky=True, UseTargetHost=False, AddRemoteIPToHeader=True,
                     AddProtoToHeader=True)
        result.append(rule)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    desired = rules()
    if not args.apply:
        print(json.dumps(desired, indent=2))
        return
    credentials = json.loads((config.ROOT / 'lucky-admin.json').read_text())
    api = config.API(credentials=credentials)
    base = api.call('api/baseconfigure')['baseconfigure']
    before = api.call('api/webservice/rules')
    existing = before.get('ruleList')
    if not isinstance(existing, list):
        raise RuntimeError('Unexpected Lucky rule response')
    if (base.get('AdminWebListenIP') != '127.0.0.1'
            or base.get('AdminWebListenPort') != 16602
            or not base.get('SafeURL') or base.get('EnableOpenToken')):
        raise RuntimeError('Unexpected administration/authentication configuration')
    # Never overwrite user rules or change management credentials/listener.
    for rule in existing:
        if rule.get('ListenPort') in [16601, 20195]:
            raise RuntimeError('A public ingress port is already configured; review it in Lucky')
    backup = config.ROOT / 'private-backups' / ('public-ingress-' + str(time.time_ns()) + '.json')
    backup.parent.mkdir(mode=0o700, exist_ok=True)
    with backup.open('x') as f:
        os.chmod(backup, 0o600)
        json.dump({'base': base, 'web': before}, f)
    updated = copy.deepcopy(base)
    # Forwarded public clients are deliberately authorized, but the backend stays
    # loopback-only; HTTPS web rules are the only externally reachable admin path.
    updated['AllowInternetaccess'] = True
    api.call('api/baseconfigure', 'PUT', updated)
    api.login(credentials)
    for rule in desired:
        api.call('api/webservice/rules', 'POST', rule)
    after = api.call('api/webservice/rules').get('ruleList', [])
    if len(after) != len(existing) + 2:
        raise RuntimeError('Public ingress verification failed; inspect the private backup')
    for old in existing:
        matches = [r for r in after if r.get('RuleKey') == old.get('RuleKey')]
        if len(matches) != 1 or matches[0] != old:
            raise RuntimeError('An existing Web rule changed unexpectedly')
    print(json.dumps({'publicIngressAdded': True, 'managementHttpsPort': 16601,
                      'sharedServiceHttpsPort': 20195, 'existingWebRulesPreserved': True,
                      'credentialsUnchanged': True}))


if __name__ == '__main__':
    main()
