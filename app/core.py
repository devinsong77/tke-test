"""Durable review records and deterministic fail-closed policy evaluation."""
import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', '/data'))
CONFIG = Path(os.getenv('CONFIG_DIR', '/config'))
TERMINAL = {'PASS', 'BLOCK', 'ERROR'}
TOOLS = ('sonarqube', 'checkov', 'trivy', 'gitleaks')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


@contextmanager
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DATA / 'reviews.db', timeout=30)
    if (DATA / 'reviews.db').stat().st_uid == os.getuid():
        os.chmod(DATA / 'reviews.db', 0o660)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA foreign_keys=ON')
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def init_db():
    with db() as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY, caller TEXT NOT NULL, idem TEXT NOT NULL,
          request_digest TEXT NOT NULL, request TEXT NOT NULL,
          status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
          result TEXT, dojo TEXT NOT NULL DEFAULT '{}', UNIQUE(caller,idem));
        CREATE TABLE IF NOT EXISTS nonces (
          caller TEXT, nonce TEXT, created REAL, PRIMARY KEY(caller,nonce));
        CREATE TABLE IF NOT EXISTS audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT,
          timestamp REAL NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
        ''')


def audit(rid, event, details):
    with db() as con:
        con.execute('INSERT INTO audit(review_id,timestamp,event,details) VALUES (?,?,?,?)',
                    (rid, time.time(), event, json.dumps(details)))


def config(name):
    return json.loads((CONFIG / name).read_text())


def policy():
    return config('policy-v1.json')


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w') as out:
        json.dump(data, out, indent=2)
        out.flush()
        os.fsync(out.fileno())
    temp.replace(path)


def is_pipeline_review(row):
    run_id = str(json.loads(row['request']).get('ado_run_id', ''))
    return run_id.isascii() and run_id.isdigit() and int(run_id) > 0


def github_repository_url(repository):
    # Export only a public GitHub path, never clone credentials or local paths.
    try:
        url = config('repositories.json').get(repository, {}).get('url', '')
    except (OSError, ValueError):
        return None
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?', url)
    return 'https://github.com/' + match[1] if match else None


def public_review(row):
    request = json.loads(row['request'])
    return {'review_id': row['id'], 'status': row['status'],
            'created_at': row['created'], 'updated_at': row['updated'],
            'request': request, 'request_digest': row['request_digest'],
            'repository_url': github_repository_url(request['repository']),
            'result': json.loads(row['result']) if row['result'] else None,
            'dojo': json.loads(row['dojo'])}


def evaluate(request, inventory, scans, findings, active_policy):
    errors = []
    for tool in TOOLS:
        scan = scans.get(tool, {})
        if scan.get('status') != 'success':
            errors.append(f'{tool}: {scan.get("error", "required scan missing or incomplete")}')
        if scan.get('commit_sha') != request['commit_sha']:
            errors.append(f'{tool}: commit binding mismatch')
    for item in inventory:
        if item['status'] not in ('covered', 'N/A'):
            errors.append(f'Uncovered input: {item["path"]}')
        if item['status'] == 'N/A' and not item.get('reason'):
            errors.append(f'N/A without reason: {item["path"]}')
    if errors:
        return {'status': 'ERROR', 'reasons': errors}
    blocking = [f for f in findings if is_blocking(f, active_policy)]
    reasons = [f'{len(blocking)} finding(s) violate policy'] if blocking else []
    if active_policy['require_sonar_quality_gate'] and scans['sonarqube'].get('quality_gate') != 'OK':
        reasons.append('SonarQube Quality Gate did not pass')
    return {'status': 'BLOCK' if reasons else 'PASS',
            'reasons': reasons or ['All required scans completed; no blocking policy violations'],
            'blocking_count': len(blocking)}


def is_blocking(finding, active_policy):
    if finding['tool'] == 'gitleaks' and active_policy['block_any_secret']:
        return True
    if finding['tool'] == 'sonarqube' and finding.get('category', 'VULNERABILITY') not in active_policy.get('sonar_block_issue_types', ['VULNERABILITY', 'BUG']):
        return False
    return finding['severity'] in active_policy['block_severities']
