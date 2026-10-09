#!/usr/bin/env python3
"""Replace bootstrap administrator tokens with dedicated scanner/import identities."""
import json
import secrets
import subprocess
from pathlib import Path
import httpx
base=Path('/opt/tke-governance')
path=base/'config/integrations.json'
settings=json.loads(path.read_text())
env=dict(line.split('=',1) for line in (base/'.env').read_text().splitlines() if '=' in line)
if settings['sonar'].get('principal') != 'governance-worker':
    password='Aa1!'+secrets.token_urlsafe(32)
    with httpx.Client(base_url=settings['sonar']['url'],auth=('admin',env['SONAR_ADMIN_PASSWORD']),timeout=30) as c:
        r=c.post('/api/users/create',data={'login':'governance-worker','name':'Governance Worker','password':password,'local':'true'})
        r.raise_for_status()
        for permission in ('provisioning','scan'):
            c.post('/api/permissions/add_user',data={'login':'governance-worker','permission':permission}).raise_for_status()
        r=c.post('/api/user_tokens/generate',data={'login':'governance-worker','name':'governance-worker-service','type':'USER_TOKEN'})
        r.raise_for_status()
        settings['sonar'].update(token=r.json()['token'],principal='governance-worker')
        c.post('/api/user_tokens/revoke',data={'name':'governance-worker','login':'admin'}).raise_for_status()
    path.write_text(json.dumps(settings,indent=2))
    print('Sonar worker now uses dedicated create-project/analyze principal')
if settings['dojo'].get('principal') != 'governance-importer':
    script=f'''
from django.contrib.auth import get_user_model
from dojo.models import Product, Product_Member
from rest_framework.authtoken.models import Token
user, created = get_user_model().objects.get_or_create(username="governance-importer", defaults={{"is_staff": False, "is_superuser": False, "is_active": True}})
if created:
 user.set_unusable_password(); user.save()
product = Product.objects.get(pk={int(settings['dojo']['product_id'])})
Product_Member.objects.get_or_create(product=product, user=user, defaults={{"role_id": 1}})
token, _ = Token.objects.get_or_create(user=user)
print("SERVICE_TOKEN=" + token.key)
'''
    result=subprocess.run(['docker','compose','-f',str(base/'compose.tools.yml'),'exec','-T','uwsgi','python','manage.py','shell','-c',script],capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-2500:])
    token=next(line.split('=',1)[1] for line in result.stdout.splitlines() if line.startswith('SERVICE_TOKEN='))
    settings['dojo'].update(token=token,principal='governance-importer')
    path.write_text(json.dumps(settings,indent=2))
    print('Dojo worker now uses a nonstaff, single-product importer')
