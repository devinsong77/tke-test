"""Single durable worker with conservative crash recovery and independent Dojo retries."""
import fcntl
import hashlib
import json
import os
import shutil
import time
from pathlib import Path
import httpx
from app import core, scanners


def finish(rid, request, result, dest):
    result.update(review_id=rid, commit_sha=request['commit_sha'], policy_version=request['policy_version'],
                  policy_digest=request['policy_digest'], finished_at=time.time())
    core.atomic_json(dest / 'decision.json', result)
    artifacts = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in dest.glob('*.json')}
    result['artifacts'] = artifacts
    with core.db() as con:
        con.execute('UPDATE reviews SET status=?,result=?,updated=? WHERE id=?',
                    (result['status'], json.dumps(result), time.time(), rid))
    core.audit(rid, 'review.finished', {'status': result['status'], 'reasons': result['reasons'], 'artifacts': artifacts})


def run(row):
    rid = row['id']
    request = json.loads(row['request'])
    dest = core.DATA / 'reviews' / rid
    dest.mkdir(parents=True, exist_ok=True)
    source = core.DATA / 'work' / rid
    findings, scans, inventory = [], {}, []
    started = time.time()
    core.audit(rid, 'review.started', {'commit_sha': request['commit_sha']})
    try:
        policy = core.policy()
        if core.digest(policy) != request['policy_digest']:
            raise ValueError('Policy changed after request acceptance')
        repo = core.config('repositories.json')[request['repository']]
        url = repo['url']
        if not url.startswith('https://github.com/') and not (repo.get('local_fixture') and url.startswith('/opt/tke-fixtures/')):
            raise ValueError('Repository transport not approved')
        source.parent.mkdir(parents=True, exist_ok=True)
        scanners.checked(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-checkout', '--', url, str(source)], timeout=120)
        scanners.checked(['git', '-C', str(source), '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', request['commit_sha']], timeout=60)
        actual = scanners.checked(['git', '-C', str(source), 'rev-parse', 'HEAD']).strip()
        if actual != request['commit_sha']:
            raise ValueError('Checked-out commit mismatch')
        inventory = scanners.inventory(source)
        # Reject repository-controlled scanner suppressions/settings that could bypass the gate.
        forbidden = {'.gitleaks.toml', '.gitleaksignore', '.checkov.yml', '.checkov.yaml', '.trivyignore', 'trivy.yaml', 'sonar-project.properties'}
        if any(Path(x['path']).name in forbidden for x in inventory):
            raise ValueError('Repository-local scanner overrides are not allowed; request a server policy review')
        core.atomic_json(dest / 'inventory.json', inventory)
        core.atomic_json(dest / 'policy.json', policy)
        core.atomic_json(dest / 'request.json', request)
        for tool in core.TOOLS:
            # Fault injection is an admin-owned file bound to a commit; not a public API parameter.
            marker = core.CONFIG / 'faults' / request['commit_sha']
            fault = marker.read_text().strip() if marker.exists() else ''
            if fault == tool:
                exit_code, _, _ = scanners.docker(tool, source, rid, [], extra=['--entrypoint', '/nonexistent-controlled-fault'])
                if exit_code == 0:
                    raise RuntimeError('Fault injection unexpectedly succeeded')
                scan = {'status': 'failed', 'commit_sha': actual, 'image': scanners.IMAGES[tool],
                        'error': 'Controlled scanner startup failure (missing entrypoint)', 'exit_code': exit_code}
                core.atomic_json(dest / f'{tool}-metadata.json', scan)
                core.audit(rid, 'fault.injected', {'tool': tool, 'commit_sha': actual})
                items = []
            else:
                scan, items = scanners.run_scanner(tool, source, dest, rid, request, policy)
            scans[tool] = scan
            findings += items
        for item in inventory:
            item['status'] = 'covered' if all(scans[t]['status'] == 'success' for t in item['required_tools']) else 'missing'
            if 'sonarqube' in item['required_tools'] and item['path'] not in scans['sonarqube'].get('analyzed_files', []):
                item['status'] = 'missing'
            if 'checkov' in item['required_tools'] and item['path'] not in scans['checkov'].get('checked_files', []):
                item['status'] = 'missing'
            if 'trivy' in item['required_tools'] and not any(item['path'] in t for t in scans['trivy'].get('targets', [])):
                item['status'] = 'missing'
        core.atomic_json(dest / 'inventory.json', inventory)
        core.atomic_json(dest / 'findings.json', findings)
        result = core.evaluate(request, inventory, scans, findings, policy)
    except Exception as error:
        result = {'status': 'ERROR', 'reasons': [f'{type(error).__name__}: {error}'[:500]]}
    result.update(scanners=scans, findings=findings, inventory=inventory,
                  duration_seconds=round(time.time() - started, 2))
    finish(rid, request, result, dest)
    shutil.rmtree(source, ignore_errors=True)


def sync_dojo(row):
    result = json.loads(row['result'] or '{}')
    if not result.get('scanners'):
        return
    state = json.loads(row['dojo'])
    if state.get('status') == 'synced' or state.get('retry_at', 0) > time.time():
        return
    rid = row['id']
    request = json.loads(row['request'])
    try:
        settings = core.config('integrations.json')['dojo']
        with httpx.Client(base_url=settings['url'], headers={'Authorization': f'Token {settings["token"]}'}, timeout=60) as client:
            if not state.get('engagement_id'):
                # Look up by exact review identifier to recover from a lost creation response.
                response = client.get('/api/v2/engagements/', params={'name': rid})
                response.raise_for_status()
                matches = [e for e in response.json()['results'] if e['name'] == rid]
                if matches:
                    eid = matches[0]['id']
                else:
                    today = time.strftime('%Y-%m-%d', time.gmtime())
                    response = client.post('/api/v2/engagements/', json={'name': rid, 'product': settings['product_id'],
                        'target_start': today, 'target_end': today, 'status': 'Completed', 'engagement_type': 'CI/CD',
                        'description': f'Commit {request["commit_sha"]}\nADO {request["ado_run_url"]}'})
                    response.raise_for_status()
                    eid = response.json()['id']
                state['engagement_id'] = eid
            state.setdefault('imports', {})
            for tool, scan in result['scanners'].items():
                if scan['status'] != 'success' or tool in state['imports']:
                    continue
                generic = {'findings': [{'title': f'{f["rule"]}: {f["title"]}'[:500],
                    'severity': f['severity'].title() if f['severity'] != 'INFO' else 'Info',
                    'description': f'{f["description"]}\nreview_id: {rid}\ncommit: {request["commit_sha"]}',
                    'mitigation': f['remediation'], 'file_path': f['file'], 'line': f['line'] or None,
                    'unique_id_from_tool': f['fingerprint'], 'active': True, 'verified': False,
                    'static_finding': True, 'dynamic_finding': False} for f in result['findings'] if f['tool'] == tool]}
                response = client.post('/api/v2/reimport-scan/', data={
                    'engagement': str(state['engagement_id']), 'product_name': 'TKE Governance Pilot',
                    'engagement_name': rid, 'scan_type': 'Generic Findings Import',
                    'test_title': f'{rid}-{tool}', 'minimum_severity': 'Info', 'close_old_findings': 'false',
                    'commit_hash': request['commit_sha'], 'build_id': request['ado_run_id'],
                    'version': request['policy_version'], 'auto_create_context': 'true'},
                    files={'file': (f'{tool}.json', json.dumps(generic).encode(), 'application/json')})
                response.raise_for_status()
                data = response.json()
                state['imports'][tool] = {'test_id': data.get('test'), 'imported_at': time.time()}
            required = {t for t,s in result['scanners'].items() if s['status'] == 'success'}
            state.update(status='synced' if required <= state['imports'].keys() else 'pending',
                         url=f'{settings["public_url"]}/engagement/{state["engagement_id"]}', error=None)
    except Exception as error:
        detail = str(error)[:200]
        if isinstance(error, httpx.HTTPStatusError):
            detail = f'HTTP {error.response.status_code}: {error.response.text[:1000]}'
        state.update(status='pending_retry', error=detail,
                     attempts=state.get('attempts', 0) + 1)
        state['retry_at'] = time.time() + min(300, 15 * 2 ** min(state['attempts'], 4))
    with core.db() as con:
        con.execute('UPDATE reviews SET dojo=? WHERE id=?', (json.dumps(state), rid))
    core.audit(rid, 'dojo.' + state['status'], state)


def main():
    core.init_db()
    lock = (core.DATA / 'worker.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # In-flight evidence cannot be trusted after a crash; preserve it and mark ERROR.
    with core.db() as con:
        abandoned = con.execute("SELECT * FROM reviews WHERE status='running'").fetchall()
    for row in abandoned:
        dest = core.DATA / 'reviews' / row['id']
        finish(row['id'], json.loads(row['request']), {'status': 'ERROR', 'reasons': ['Worker restarted during scan; submit a new run'],
                'scanners': {}, 'findings': [], 'inventory': []}, dest)
    while True:
        with core.db() as con:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute("SELECT * FROM reviews WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row:
                con.execute("UPDATE reviews SET status='running',updated=? WHERE id=?", (time.time(), row['id']))
        if row:
            run(row)
        with core.db() as con:
            done = con.execute("SELECT * FROM reviews WHERE status IN ('PASS','BLOCK','ERROR') ORDER BY created DESC").fetchall()
        for completed in done:
            sync_dojo(completed)
        time.sleep(2)


if __name__ == '__main__':
    main()
