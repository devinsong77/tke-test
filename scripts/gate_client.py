#!/usr/bin/env python3
"""ADO gate: signed submission, bounded retries/polling, only PASS exits zero."""
import hashlib
import hmac
import json
import os
import ssl
import sys
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path


def main():
    base = os.environ['GATE_URL'].rstrip('/')
    if not base.startswith('https://'):
        raise ValueError('HTTPS is required')
    context = ssl.create_default_context(cafile=os.environ.get('GATE_CA_FILE') or None)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    token = os.environ['GATE_TOKEN']
    key = os.environ['GATE_HMAC_KEY']
    commit = os.environ['BUILD_SOURCEVERSION']
    run_id = os.environ['BUILD_BUILDID']
    payload = {'repository': os.environ.get('GATE_REPOSITORY', 'tke-test'), 'commit_sha': commit,
               'policy_version': 'policy-v1', 'ado_run_id': run_id,
               'ado_run_url': os.environ['ADO_RUN_URL'],
               'ref': os.environ.get('BUILD_SOURCEBRANCH', 'refs/heads/main')}
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
    idem = hashlib.sha256((payload['ado_run_url'] + commit).encode()).hexdigest()
    end = time.monotonic() + int(os.environ.get('GATE_TIMEOUT_SECONDS', '1800'))

    def call(path, data=None):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if data is not None:
            timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
            message = f'POST\n/api/v1/reviews\n{timestamp}\n{nonce}\n{idem}\n{hashlib.sha256(data).hexdigest()}'
            headers.update({'X-Timestamp': timestamp, 'X-Nonce': nonce, 'Idempotency-Key': idem,
                            'X-Signature': hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()})
        request = urllib.request.Request(base + path, data=data, headers=headers)
        with urllib.request.urlopen(request, context=context, timeout=min(30, max(1, end-time.monotonic()))) as response:
            return json.load(response)

    created = None
    for attempt in range(3):
        try:
            created = call('/api/v1/reviews', raw)
            break
        except urllib.error.HTTPError as error:
            if error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2 ** attempt)
    if not created:
        raise RuntimeError('Unable to submit review after retries')
    rid = created['review_id']
    print(f'POST /api/v1/reviews accepted; review_id={rid}', flush=True)
    failures = 0
    while time.monotonic() < end:
        try:
            result = call('/api/v1/reviews/' + rid)
            failures = 0
        except (urllib.error.URLError, TimeoutError):
            failures += 1
            if failures >= 3:
                raise RuntimeError('Polling failed three consecutive times')
            time.sleep(3)
            continue
        returned_request = result.get('request', {})
        if result.get('review_id') != rid or any(returned_request.get(k) != v for k, v in payload.items()):
            raise RuntimeError('Review identity mismatch')
        status = result.get('status')
        print(f'GET review_id={rid} status={status}', flush=True)
        if status in ('PASS', 'BLOCK', 'ERROR'):
            decision = result.get('result') or {}
            if decision.get('status') != status or decision.get('commit_sha') != commit or decision.get('policy_version') != 'policy-v1' or decision.get('policy_digest') != returned_request.get('policy_digest'):
                raise RuntimeError('Terminal evidence mismatch')
            output = Path(os.environ.get('GATE_EVIDENCE_DIR', 'gate-evidence'))
            output.mkdir(parents=True, exist_ok=True)
            (output / 'review.json').write_text(json.dumps(result, indent=2))
            print(json.dumps({'review_id': rid, 'status': status, 'reasons': decision.get('reasons')}, indent=2))
            if status == 'PASS':
                print('##vso[task.setvariable variable=gatePassed;isOutput=true]true')
                return 0
            return 2 if status == 'BLOCK' else 3
        if status not in ('queued', 'running'):
            raise RuntimeError('Unknown API state; refusing to continue')
        time.sleep(5)
    raise TimeoutError('Gate timed out; publishing is blocked')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Gate ERROR: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(3)
