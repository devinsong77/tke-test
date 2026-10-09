import httpx,json,pathlib
base=pathlib.Path('/opt/tke-governance');e=dict(l.split('=',1) for l in (base/'.env').read_text().splitlines() if '=' in l)
with httpx.Client(base_url='http://127.0.0.1:9000',auth=('admin',e['SONAR_ADMIN_PASSWORD']),timeout=30) as c:
 d=c.get('/api/permissions/search_templates').json();template=d['permissionTemplates'][0]['id']
 for perm in ['admin','user','codeviewer','scan']:
  r=c.post('/api/permissions/add_user_to_template',data={'templateId':template,'login':'governance-worker','permission':perm});print('template',perm,r.status_code)
 projects=c.get('/api/projects/search',params={'ps':500}).json()['components']
 for p in projects:
  if p['key'].startswith('tke-'):
   for perm in ['admin','user','codeviewer','scan']:
    c.post('/api/permissions/add_user',data={'projectKey':p['key'],'login':'governance-worker','permission':perm}).raise_for_status()
 print('Assigned project-scoped service permissions to governance projects')
