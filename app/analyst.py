"""AI-assisted findings analysis. Strictly advisory: never influences the gate decision.

This module calls an external LLM API to generate plain-language summaries of
review findings. It is read-only with respect to the gate: the analysis is
stored separately, clearly labeled, and the gate decision (PASS/BLOCK/ERROR)
is computed deterministically without any LLM involvement.
"""
import json
import time
import urllib.request
from app import core


SYSTEM_PROMPT = """You are a senior application security analyst reviewing automated scan findings.
Given the JSON findings from SonarQube, Checkov, Trivy, and Gitleaks, produce a concise
analyst brief in Markdown with exactly these sections:

## Summary
2-3 sentences: what was scanned, overall risk posture.

## Priority findings
Top 5 findings by risk, each as: - [SEVERITY] rule (tool) — file:line — one-line why it matters.

## Remediation plan
Numbered steps, most urgent first. Be concrete (file paths, commands where obvious).

## False-positive notes
Any finding that looks like a likely false positive and why, or "None identified."

Rules: do not invent findings not in the input. Do not reveal secrets (values are already redacted).
Keep the whole brief under 400 words."""


def _config():
    cfg = core.config('integrations.json').get('ai_analyst')
    if not cfg or not cfg.get('api_key'):
        return None
    return cfg


def build_prompt(result):
    findings = result.get('findings', [])
    scanners = {k: {'status': v.get('status'), 'error': v.get('error')}
                for k, v in result.get('scanners', {}).items()}
    slim = [{'tool': f['tool'], 'rule': f['rule'], 'severity': f['severity'],
             'title': f['title'], 'file': f['file'], 'line': f['line'],
             'remediation': f['remediation']}
            for f in findings[:80]]
    return json.dumps({'decision': result.get('status'),
                       'reasons': result.get('reasons'),
                       'scanners': scanners,
                       'finding_count': len(findings),
                       'findings': slim}, indent=1)


def analyze(review_id, result):
    """Generate an advisory analysis. Returns dict; raises on LLM failure."""
    cfg = _config()
    if cfg is None:
        raise RuntimeError('AI analyst not configured (no API key)')
    body = {
        'model': cfg.get('model', 'gpt-4o-mini'),
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_prompt(result)},
        ],
        'max_tokens': 1200,
        'temperature': 0.2,
    }
    req = urllib.request.Request(
        cfg.get('base_url', 'https://api.openai.com/v1').rstrip('/') + '/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + cfg['api_key']},
        method='POST')
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
    except Exception as e:
        raise RuntimeError(f'LLM API call failed: {type(e).__name__}: {e}'[:300])
    text = (data.get('choices') or [{}])[0].get('message', {}).get('content', '').strip()
    if not text:
        raise RuntimeError('LLM returned empty analysis')
    return {
        'review_id': review_id,
        'model': body['model'],
        'generated_at': time.time(),
        'duration_seconds': round(time.time() - started, 1),
        'brief': text,
        'disclaimer': ('AI-generated advisory summary. It does not affect the gate decision, '
                       'which is computed deterministically from scanner evidence and policy.'),
    }


def get_cached(review_id):
    path = core.DATA / 'reviews' / review_id / 'ai-analysis.json'
    if path.is_file():
        return json.loads(path.read_text())
    return None


def generate_and_store(review_id):
    with core.db() as con:
        row = con.execute('SELECT * FROM reviews WHERE id=?', (review_id,)).fetchone()
    if row is None:
        raise ValueError('Review not found')
    if row['status'] not in core.TERMINAL:
        raise ValueError('Review has no terminal decision yet')
    cached = get_cached(review_id)
    if cached:
        return cached
    result = json.loads(row['result'])
    analysis = analyze(review_id, result)
    core.atomic_json(core.DATA / 'reviews' / review_id / 'ai-analysis.json', analysis)
    core.audit(review_id, 'analysis.generated',
               {'model': analysis['model'], 'duration': analysis['duration_seconds']})
    return analysis
