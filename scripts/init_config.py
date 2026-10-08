#!/usr/bin/env python3
"""Create configuration on the server; never print or commit generated credentials."""
import json
import secrets
from pathlib import Path
base = Path('/opt/tke-governance')
config = base / 'config'
config.mkdir(parents=True, exist_ok=True)

def write_once(name, data):
    path = config / name
    if not path.exists():
        path.write_text(json.dumps(data, indent=2))
        path.chmod(0o640)

write_once('clients.json', {
    'ado': {'role': 'pipeline', 'repositories': ['tke-test', 'pilot'], 'token': secrets.token_urlsafe(36), 'hmac_key': secrets.token_urlsafe(48)},
    'reviewer': {'role': 'reader', 'repositories': ['tke-test', 'pilot'], 'token': secrets.token_urlsafe(36)}})
write_once('repositories.json', {
    'tke-test': {'url': 'https://github.com/devinsong77/tke-test.git', 'ado_url_prefix': 'https://dev.azure.com/NOT-CONFIGURED/'},
    'pilot': {'url': '/opt/tke-fixtures/pilot.git', 'local_fixture': True, 'ado_url_prefix': 'https://dev.azure.com/local-smoke/'}})
write_once('integrations.json', {'sonar': {'url': 'http://127.0.0.1:9000', 'token': ''},
                               'dojo': {'url': 'http://127.0.0.1:8080', 'public_url': 'https://64.90.11.59:9443', 'token': '', 'product_id': 0}})
print('Configuration initialized. Credentials remain in root-managed config/clients.json.')
