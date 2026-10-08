#!/usr/bin/env python3
"""Initialize service credentials on the host without writing them to stdout."""
import json
import secrets
from pathlib import Path
import httpx

base = Path('/opt/tke-governance')
path = base / 'config/integrations.json'
settings = json.loads(path.read_text())
env = dict(line.split('=', 1) for line in (base / '.env').read_text().splitlines() if '=' in line)
if not settings['sonar']['token']:
    password = env.get('SONAR_ADMIN_PASSWORD') or ('Aa1!' + secrets.token_urlsafe(32))
    with httpx.Client(base_url=settings['sonar']['url'], timeout=30) as client:
        if 'SONAR_ADMIN_PASSWORD' not in env:
            response = client.post('/api/users/change_password', auth=('admin', 'admin'),
                                   data={'login': 'admin', 'previousPassword': 'admin', 'password': password})
            response.raise_for_status()
            with (base / '.env').open('a') as out:
                out.write('\nSONAR_ADMIN_PASSWORD=' + password + '\n')
        client.cookies.clear()
        response = client.post('/api/user_tokens/generate', auth=('admin', password),
                               data={'name': 'governance-worker', 'type': 'USER_TOKEN'})
        response.raise_for_status()
        settings['sonar']['token'] = response.json()['token']
        path.write_text(json.dumps(settings, indent=2))
        # Force user authentication for all project data.
        client.post('/api/settings/set', auth=('admin', password), data={'key': 'sonar.forceAuthentication', 'value': 'true'}).raise_for_status()
    print('SonarQube credentials initialized')
if not settings['dojo']['token']:
    with httpx.Client(base_url=settings['dojo']['url'], timeout=30) as client:
        response = client.post('/api/v2/api-token-auth/', json={'username': 'admin', 'password': env['DOJO_ADMIN_PASSWORD']})
        response.raise_for_status()
        settings['dojo']['token'] = response.json()['token']
        client.headers['Authorization'] = 'Token ' + settings['dojo']['token']
        response = client.post('/api/v2/product_types/', json={'name': 'TKE Security Governance'})
        response.raise_for_status()
        product_type = response.json()['id']
        response = client.post('/api/v2/products/', json={'name': 'TKE Governance Pilot', 'description': 'Server-side security review evidence', 'prod_type': product_type})
        response.raise_for_status()
        settings['dojo']['product_id'] = response.json()['id']
        path.write_text(json.dumps(settings, indent=2))
    print('DefectDojo credentials and product initialized')
