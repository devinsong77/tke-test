#!/usr/bin/env python3
"""Host-only API smoke test; expressly not an Azure DevOps acceptance run."""
import hashlib
import hmac
import json
import sys
import time
import uuid
from pathlib import Path
import httpx

base = Path('/opt/tke-governance')
client = json.loads((base / 'config/clients.json').read_text())['ado']
commit = sys.argv[1]
payload = {'repository': (sys.argv[2] if len(sys.argv) > 2 else 'pilot'), 'commit_sha': commit, 'policy_version': 'policy-v1',
           'ado_run_id': 'host-smoke-' + str(int(time.time())),
           'ado_run_url': 'https://dev.azure.com/local-smoke/not-a-real-ado-run', 'ref': 'refs/heads/main'}
if payload['repository'] == 'tke-test':
    payload['ado_run_url'] = 'https://dev.azure.com/devinsong77-tke/tke-test/_build/results?buildId=0'
raw = json.dumps(payload).encode()
nonce, timestamp, idem = uuid.uuid4().hex, str(int(time.time())), uuid.uuid4().hex
message = f'POST\n/api/v1/reviews\n{timestamp}\n{nonce}\n{idem}\n{hashlib.sha256(raw).hexdigest()}'
headers = {'Authorization': 'Bearer ' + client['token'], 'X-Timestamp': timestamp, 'X-Nonce': nonce,
           'Idempotency-Key': idem, 'X-Signature': hmac.new(client['hmac_key'].encode(), message.encode(), hashlib.sha256).hexdigest()}
with httpx.Client(base_url='http://127.0.0.1:8000', timeout=20) as session:
    r = session.post('/api/v1/reviews', content=raw, headers=headers)
    r.raise_for_status()
    rid = r.json()['review_id']
    print('HOST SMOKE ONLY review_id=' + rid, flush=True)
    for i in range(360):
        r = session.get('/api/v1/reviews/' + rid, headers={'Authorization': 'Bearer ' + client['token']})
        r.raise_for_status()
        data = r.json()
        if i % 6 == 0: print(data['status'], flush=True)
        if data['status'] in ('PASS', 'BLOCK', 'ERROR'):
            print(json.dumps({'review_id': rid, 'status': data['status'], 'result': data['result']}, indent=2), flush=True)
            break
        time.sleep(5)
