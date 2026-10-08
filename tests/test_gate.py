import hashlib
import hmac
import json
import time
import uuid
import pytest
from fastapi.testclient import TestClient
from app import core
from app.api import app


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(core, 'DATA', tmp_path / 'data')
    monkeypatch.setattr(core, 'CONFIG', tmp_path / 'config')
    core.CONFIG.mkdir()
    settings = {'clients.json': {'ado': {'token': 'pipeline-token', 'hmac_key': 'signing-key', 'role': 'pipeline', 'repositories': ['pilot']},
                                'reader': {'token': 'read-token', 'role': 'reader', 'repositories': ['pilot']},
                                'other': {'token': 'other-token', 'role': 'reader', 'repositories': ['other']}},
                'repositories.json': {'pilot': {'url': 'https://github.com/example/pilot.git', 'ado_url_prefix': 'https://dev.azure.com/test/project/'}},
                'policy-v1.json': {'version': 'policy-v1', 'block_severities': ['HIGH', 'CRITICAL'], 'block_any_secret': True, 'require_sonar_quality_gate': True}}
    for name, data in settings.items():
        (core.CONFIG / name).write_text(json.dumps(data))
    with TestClient(app) as client:
        yield client


def payload():
    return {'repository': 'pilot', 'commit_sha': 'a' * 40, 'policy_version': 'policy-v1',
            'ado_run_id': '42', 'ado_run_url': 'https://dev.azure.com/test/project/_build/results?buildId=42'}


def signed(data=None, idem='test-idempotency', timestamp=None):
    data = data or payload()
    raw = json.dumps(data).encode()
    ts, nonce = str(timestamp or int(time.time())), uuid.uuid4().hex
    message = f'POST\n/api/v1/reviews\n{ts}\n{nonce}\n{idem}\n{hashlib.sha256(raw).hexdigest()}'
    headers = {'Authorization': 'Bearer pipeline-token', 'X-Timestamp': ts, 'X-Nonce': nonce, 'Idempotency-Key': idem,
               'X-Signature': hmac.new(b'signing-key', message.encode(), hashlib.sha256).hexdigest()}
    return {'content': raw, 'headers': headers}


def test_auth_and_read_only(setup):
    assert setup.get('/api/v1/reviews').status_code == 401
    assert setup.post('/api/v1/reviews', headers={'Authorization': 'Bearer read-token'}, json=payload()).status_code == 403


def test_signed_create_idempotency_and_replay(setup):
    request = signed()
    first = setup.post('/api/v1/reviews', **request)
    assert first.status_code == 202
    assert setup.post('/api/v1/reviews', **request).status_code == 409
    second = setup.post('/api/v1/reviews', **signed())
    assert second.json()['review_id'] == first.json()['review_id']
    changed = payload(); changed['commit_sha'] = 'b' * 40
    assert setup.post('/api/v1/reviews', **signed(changed)).status_code == 409


def test_signature_expiry_and_tampering(setup):
    assert setup.post('/api/v1/reviews', **signed(timestamp=int(time.time()) - 400)).status_code == 401
    request = signed(); request['content'] += b' '
    assert setup.post('/api/v1/reviews', **request).status_code == 401


def test_repository_and_ado_binding(setup):
    p = payload(); p['repository'] = 'unapproved'
    assert setup.post('/api/v1/reviews', **signed(p)).status_code == 403
    p = payload(); p['ado_run_url'] = 'https://dev.azure.com/other/project/run'
    assert setup.post('/api/v1/reviews', **signed(p)).status_code == 403


def test_cross_repository_access_is_hidden(setup):
    rid = setup.post('/api/v1/reviews', **signed()).json()['review_id']
    assert setup.get('/api/v1/reviews/' + rid, headers={'Authorization': 'Bearer other-token'}).status_code == 404
    assert setup.get('/api/v1/reviews', headers={'Authorization': 'Bearer other-token'}).json() == {'reviews': []}


def clean_scans():
    return {name: {'status': 'success', 'commit_sha': 'a' * 40, 'quality_gate': 'OK'} for name in core.TOOLS}


def test_pass_requires_all_scans(setup):
    scans = clean_scans()
    assert core.evaluate(payload(), [], scans, [], core.policy())['status'] == 'PASS'
    del scans['trivy']
    assert core.evaluate(payload(), [], scans, [], core.policy())['status'] == 'ERROR'


def test_errors_take_precedence_over_findings(setup):
    scans = clean_scans(); scans['gitleaks']['status'] = 'failed'
    findings = [{'tool': 'trivy', 'severity': 'CRITICAL'}]
    assert core.evaluate(payload(), [], scans, findings, core.policy())['status'] == 'ERROR'


def test_commit_mismatch_and_missing_coverage(setup):
    scans = clean_scans(); scans['trivy']['commit_sha'] = 'b' * 40
    assert core.evaluate(payload(), [], scans, [], core.policy())['status'] == 'ERROR'
    assert core.evaluate(payload(), [{'path': 'Dockerfile', 'status': 'missing'}], clean_scans(), [], core.policy())['status'] == 'ERROR'
    assert core.evaluate(payload(), [{'path': 'x.tf', 'status': 'N/A'}], clean_scans(), [], core.policy())['status'] == 'ERROR'


def test_high_risk_and_sonar_gate_block(setup):
    assert core.evaluate(payload(), [], clean_scans(), [{'tool': 'gitleaks', 'severity': 'LOW'}], core.policy())['status'] == 'BLOCK'
    scans = clean_scans(); scans['sonarqube']['quality_gate'] = 'ERROR'
    assert core.evaluate(payload(), [], scans, [], core.policy())['status'] == 'BLOCK'


def test_artifact_integrity(setup):
    rid = setup.post('/api/v1/reviews', **signed()).json()['review_id']
    dest = core.DATA / 'reviews' / rid; dest.mkdir(parents=True)
    (dest / 'decision.json').write_text('{}')
    with core.db() as con:
        con.execute('UPDATE reviews SET result=? WHERE id=?', (json.dumps({'artifacts': {'decision.json': hashlib.sha256(b'{}').hexdigest()}}), rid))
    url = f'/api/v1/reviews/{rid}/artifacts/decision.json'
    headers = {'Authorization': 'Bearer read-token'}
    assert setup.get(url, headers=headers).status_code == 200
    (dest / 'decision.json').write_text('{"status":"PASS"}')
    assert setup.get(url, headers=headers).status_code == 409
