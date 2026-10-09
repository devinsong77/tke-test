"""Authenticated review API. Scanner and policy execution live in the worker."""
import hashlib
import hmac
import json
import re
import sqlite3
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from app import core


@asynccontextmanager
async def lifespan(app):
    core.init_db()
    yield


app = FastAPI(title='TKE Security Governance API', version='1.0.0', lifespan=lifespan,
              docs_url=None, redoc_url=None)


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    repository: str = Field(min_length=1, max_length=100)
    commit_sha: str = Field(pattern=r'^[0-9a-f]{40}$')
    policy_version: Literal['policy-v1']
    ado_run_id: str = Field(min_length=1, max_length=100)
    ado_run_url: str = Field(pattern=r'^https://dev\.azure\.com/[^\s]+$', max_length=500)
    ref: str = Field(default='refs/heads/main', pattern=r'^refs/heads/[a-zA-Z0-9_./-]+$', max_length=200)


async def identity(request: Request):
    clients = core.config('clients.json')
    authorization = request.headers.get('authorization', '')
    token = authorization.removeprefix('Bearer ')
    for name, client in clients.items():
        if authorization.startswith('Bearer ') and hmac.compare_digest(token, client['token']):
            return name, client
    raise HTTPException(401, 'Invalid credentials')


async def optional_identity(request: Request):
    """Authentication is optional for public read-only dashboard endpoints.

    Returns (name, client) when a valid Bearer token is present, else None.
    Write operations (POST /api/v1/reviews) still require identity.
    """
    authorization = request.headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        return None
    token = authorization.removeprefix('Bearer ')
    clients = core.config('clients.json')
    for name, client in clients.items():
        if hmac.compare_digest(token, client['token']):
            return name, client
    return None


def visible(row, client):
    return json.loads(row['request'])['repository'] in client['repositories']


@app.get('/healthz')
def health():
    with core.db() as con:
        con.execute('SELECT 1').fetchone()
    return {'status': 'ok', 'service': 'governance-api'}


def _component(name, status, version=None, latency_ms=None, error=None):
    return {'name': name, 'status': status, 'version': version,
            'latency_ms': latency_ms, 'checked_at': time.time(), 'error': error}


def _check_http_component(name, url, parse):
    """GET url with a 5s timeout; parse(response) -> (ok, version, detail)."""
    start = time.time()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'govgate-health/1.0'})
        with urllib.request.urlopen(req, timeout=5) as r:
            latency_ms = int((time.time() - start) * 1000)
            ok, version, detail = parse(r)
            status = 'up' if ok else 'degraded'
            return _component(name, status, version=version, latency_ms=latency_ms,
                              error=None if ok else detail)
    except Exception as e:
        latency_ms = int((time.time() - start) * 1000)
        return _component(name, 'down', latency_ms=latency_ms, error=str(e)[:200])


def _check_tool_component(name, image):
    """Check a scanner's Docker image is present locally so the worker can run it. 5s timeout."""
    start = time.time()
    try:
        proc = subprocess.run(['docker', 'image', 'inspect', image],
                              capture_output=True, text=True, timeout=5)
        latency_ms = int((time.time() - start) * 1000)
        if proc.returncode == 0:
            return _component(name, 'up', version=image, latency_ms=latency_ms)
        return _component(name, 'down', version=image, latency_ms=latency_ms,
                          error=f'image not present locally: {image}')
    except Exception as e:
        return _component(name, 'down', version=image,
                          latency_ms=int((time.time() - start) * 1000), error=str(e)[:200])


def _check_worker_component():
    """Worker is healthy when its process is alive. Read-only: pgrep only."""
    start = time.time()
    try:
        proc = subprocess.run(['pgrep', '-f', 'app.worker'], capture_output=True, text=True, timeout=5)
        latency_ms = int((time.time() - start) * 1000)
        if proc.returncode == 0 and proc.stdout.strip():
            return _component('worker', 'up', latency_ms=latency_ms)
        return _component('worker', 'down', latency_ms=latency_ms, error='no app.worker process found')
    except Exception as e:
        return _component('worker', 'down', latency_ms=int((time.time() - start) * 1000),
                          error=str(e)[:200])


def _sonar_parse(r):
    try:
        d = json.load(r)
    except Exception:
        return False, None, 'invalid JSON from SonarQube'
    ok = d.get('status') == 'UP'
    return ok, d.get('version'), None if ok else f"system status: {d.get('status')}"


def _dojo_parse(r):
    # DefectDojo redirects / to the login page; 200 or 30x both mean the app is up.
    return True, None, None


@app.get('/api/v1/components')
def component_health(auth=Depends(optional_identity)):
    """Read-only health of every governance component. Public, like other dashboard GETs."""
    components = [
        _component('api', 'up', version='1.0.0', latency_ms=0),
        _check_worker_component(),
        _check_http_component('sonarqube', 'http://127.0.0.1:9000/api/system/status', _sonar_parse),
        _check_http_component('defectdojo', 'http://127.0.0.1:8080/', _dojo_parse),
        _check_tool_component('checkov', 'bridgecrew/checkov:3.3.26'),
        _check_tool_component('trivy', 'aquasec/trivy:0.75.0'),
        _check_tool_component('gitleaks', 'ghcr.io/gitleaks/gitleaks:v8.30.1'),
    ]
    return {'components': components, 'checked_at': time.time()}


@app.post('/api/v1/reviews', status_code=202)
async def create_review(request: Request, auth=Depends(identity)):
    caller, client = auth
    if client['role'] != 'pipeline':
        raise HTTPException(403, 'Read-only principal')
    raw = await request.body()
    if len(raw) > 8192:
        raise HTTPException(413, 'Request too large')
    timestamp = request.headers.get('x-timestamp', '')
    nonce = request.headers.get('x-nonce', '')
    idem = request.headers.get('idempotency-key', '')
    if not re.fullmatch(r'[a-zA-Z0-9:_-]{8,160}', idem) or not re.fullmatch(r'[0-9a-f]{32}', nonce):
        raise HTTPException(400, 'Invalid idempotency key or nonce')
    try:
        if abs(time.time() - int(timestamp)) > 300:
            raise ValueError()
    except ValueError:
        raise HTTPException(401, 'Request timestamp outside five-minute window')
    body_hash = hashlib.sha256(raw).hexdigest()
    message = f'POST\n/api/v1/reviews\n{timestamp}\n{nonce}\n{idem}\n{body_hash}'
    expected = hmac.new(client['hmac_key'].encode(), message.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get('x-signature', '')):
        raise HTTPException(401, 'Invalid request signature')
    try:
        payload = ReviewRequest.model_validate_json(raw).model_dump()
    except ValueError:
        raise HTTPException(422, 'Invalid review request schema')
    repos = core.config('repositories.json')
    if payload['repository'] not in client['repositories'] or payload['repository'] not in repos:
        raise HTTPException(403, 'Repository not authorized')
    repo = repos[payload['repository']]
    if not payload['ado_run_url'].startswith(repo['ado_url_prefix']):
        raise HTTPException(403, 'ADO organization/project mismatch')
    if payload['policy_version'] != core.policy()['version']:
        raise HTTPException(409, 'Policy version mismatch')
    payload['policy_digest'] = core.digest(core.policy())
    fingerprint = core.digest(payload)
    now = time.time()
    with core.db() as con:
        con.execute('BEGIN IMMEDIATE')
        con.execute('DELETE FROM nonces WHERE created < ?', (now - 600,))
        try:
            con.execute('INSERT INTO nonces VALUES (?,?,?)', (caller, nonce, now))
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Replay detected; use a fresh nonce')
        existing = con.execute('SELECT * FROM reviews WHERE caller=? AND idem=?', (caller, idem)).fetchone()
        if existing:
            if existing['request_digest'] != fingerprint:
                raise HTTPException(409, 'Idempotency key reused for a different request')
            return {'review_id': existing['id'], 'status': existing['status'], 'reused': True}
        count = con.execute("SELECT count(*) FROM reviews WHERE status IN ('queued','running')").fetchone()[0]
        if count >= 20:
            raise HTTPException(429, 'Review queue full')
        rid = uuid.uuid4().hex
        con.execute('INSERT INTO reviews(id,caller,idem,request_digest,request,status,created,updated) VALUES (?,?,?,?,?,?,?,?)',
                    (rid, caller, idem, fingerprint, json.dumps(payload), 'queued', now, now))
    core.audit(rid, 'review.created', {'caller': caller, 'commit_sha': payload['commit_sha'], 'request_digest': fingerprint})
    return {'review_id': rid, 'status': 'queued', 'status_url': f'/api/v1/reviews/{rid}'}


@app.get('/api/v1/reviews')
def list_reviews(auth=Depends(optional_identity)):
    with core.db() as con:
        rows = con.execute('SELECT * FROM reviews ORDER BY created DESC LIMIT 100').fetchall()
    if auth is None:
        return {'reviews': [core.public_review(r) for r in rows]}
    return {'reviews': [core.public_review(r) for r in rows if visible(r, auth[1])]}


def get_row(rid, client):
    with core.db() as con:
        row = con.execute('SELECT * FROM reviews WHERE id=?', (rid,)).fetchone()
    # Public dashboard access (client is None) can see all reviews;
    # authenticated callers are still scoped to their repositories.
    if row is None or (client is not None and not visible(row, client)):
        raise HTTPException(404, 'Review not found')
    return row


@app.get('/api/v1/reviews/{rid}')
def get_review(rid: str, auth=Depends(optional_identity)):
    return core.public_review(get_row(rid, auth[1] if auth else None))


@app.get('/api/v1/reviews/{rid}/audit')
def get_audit(rid: str, auth=Depends(optional_identity)):
    get_row(rid, auth[1] if auth else None)
    with core.db() as con:
        rows = con.execute('SELECT * FROM audit WHERE review_id=? ORDER BY sequence', (rid,)).fetchall()
    return {'events': [dict(r) for r in rows]}


@app.get('/api/v1/reviews/{rid}/artifacts/{name}')
def artifact(rid: str, name: str, auth=Depends(optional_identity)):
    row = get_row(rid, auth[1] if auth else None)
    result = json.loads(row['result'] or '{}')
    if name not in result.get('artifacts', {}):
        raise HTTPException(404, 'Artifact not found')
    path = core.DATA / 'reviews' / rid / name
    if not path.is_file() or path.is_symlink():
        raise HTTPException(404, 'Artifact missing')
    if hashlib.sha256(path.read_bytes()).hexdigest() != result['artifacts'][name]:
        raise HTTPException(409, 'Artifact integrity check failed')
    return FileResponse(path, media_type='application/json', filename=name)


@app.post('/api/v1/reviews/{rid}/analysis', status_code=202)
def request_analysis(rid: str, auth=Depends(identity)):
    """Trigger AI advisory analysis. Read-only vs the gate: never changes the decision."""
    get_row(rid, auth[1])  # 404 if unknown / not visible to caller
    from app import analyst
    try:
        analysis = analyst.generate_and_store(rid)
    except ValueError as e:
        raise HTTPException(409, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {'review_id': rid, 'status': 'ready', 'model': analysis['model'],
            'disclaimer': analysis['disclaimer']}


@app.get('/api/v1/reviews/{rid}/analysis')
def get_analysis(rid: str, auth=Depends(optional_identity)):
    get_row(rid, auth[1] if auth else None)
    from app import analyst
    analysis = analyst.get_cached(rid)
    if analysis is None:
        raise HTTPException(404, 'No analysis yet; it is generated automatically after the terminal decision')
    return analysis


@app.post('/api/v1/reviews/{rid}/chat')
async def chat_with_analyst(rid: str, request: Request, auth=Depends(optional_identity)):
    """Ask a follow-up question about a review's findings.

    Read-only: the conversation is grounded on findings data and can never
    modify the review, its decision, or any finding.
    """
    get_row(rid, auth[1] if auth else None)  # 404 if unknown
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(422, 'Invalid JSON body')
    from app import analyst
    try:
        return analyst.chat(rid, payload.get('message'), payload.get('history'))
    except ValueError as e:
        raise HTTPException(409, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.get('/api/v1/reviews/{rid}/chat')
def get_chat_history(rid: str, auth=Depends(optional_identity)):
    get_row(rid, auth[1] if auth else None)
    from app import analyst
    return {'review_id': rid, 'messages': analyst.get_chat(rid)}


@app.middleware('http')
async def headers(request, call_next):
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    return response


app.mount('/', StaticFiles(directory=Path(__file__).parent / 'static', html=True), name='dashboard')
