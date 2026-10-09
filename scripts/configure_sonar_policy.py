import json,pathlib,httpx
p=pathlib.Path('/opt/tke-governance/config/integrations.json');s=json.loads(p.read_text())['sonar']
with httpx.Client(base_url=s['url'],auth=(s['token'],''),timeout=30) as c:
 r=c.get('/api/qualitygates/list');r.raise_for_status();gates=r.json()['qualitygates']
 gate=next((g for g in gates if g['name']=='TKE Security Policy'),None)
 if not gate:
  r=c.post('/api/qualitygates/create',data={'name':'TKE Security Policy'});r.raise_for_status();gate=r.json()
  for metric in ['vulnerabilities','bugs']:
   r=c.post('/api/qualitygates/create_condition',data={'gateName':gate['name'],'metric':metric,'op':'GT','error':'0'});print(metric,r.status_code,r.text[:200])
 r=c.post('/api/qualitygates/set_as_default',data={'name':gate['name']});print('default',r.status_code)
