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
    started = time.time()
    text, model = _llm_call(cfg, [
        {'role': 'system', 'content': SYSTEM_PROMPT},
        {'role': 'user', 'content': build_prompt(result)},
    ], max_tokens=1200)
    return {
        'review_id': review_id,
        'model': model,
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


def auto_generate(review_id):
    """Best-effort auto-generation on terminal state. Never raises: the gate
    decision is already durable by the time this runs, and analysis is
    strictly advisory. Failures are recorded in the audit trail only."""
    try:
        generate_and_store(review_id)
    except Exception as e:
        try:
            core.audit(review_id, 'analysis.auto_failed', {'error': str(e)[:200]})
        except Exception:
            pass


CHAT_SYSTEM_PROMPT = """You are a senior application security analyst answering follow-up questions
about one specific automated security review. You are given the review's decision,
reasons, scanner outcomes, coverage, DefectDojo sync state, and findings as JSON context.
You also know which dashboard tab the user is currently viewing.

Rules:
- Answer ONLY from the provided context data. Do not invent findings, files, severities, or sync states.
- You can answer about ANY part of the review: why the decision is BLOCK/PASS/ERROR,
  what each scanner found, coverage gaps, whether DefectDojo synced, remediation steps.
- Keep answers concise (under 150 words unless the user asks for detail).
- Do not reveal secret values (they are redacted in the input).
- You are read-only: you cannot change the review, its decision, or any finding.
  If asked to change something, explain you can only explain, not modify.
- If the question cannot be answered from the context, say so plainly."""


def _llm_call(cfg, messages, max_tokens=800):
    body = {
        'model': cfg.get('model', 'gpt-4o-mini'),
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': 0.2,
    }
    req = urllib.request.Request(
        cfg.get('base_url', 'https://api.openai.com/v1').rstrip('/') + '/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + cfg['api_key']},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
    except Exception as e:
        raise RuntimeError(f'LLM API call failed: {type(e).__name__}: {e}'[:300])
    text = (data.get('choices') or [{}])[0].get('message', {}).get('content', '').strip()
    if not text:
        raise RuntimeError('LLM returned empty response')
    return text, body['model']


def build_chat_context(result, dojo=None, tab=None):
    """Rich context for follow-up chat: decision, scanners, coverage, Dojo, findings,
    plus which dashboard tab the user is viewing so answers stay relevant."""
    findings = result.get('findings', [])
    scanners = {k: {'status': v.get('status'), 'error': v.get('error'),
                    'duration_seconds': v.get('duration_seconds')}
                for k, v in result.get('scanners', {}).items()}
    inv = result.get('inventory', [])
    uncovered = [x.get('path') for x in inv if x.get('status') != 'covered'][:20]
    slim = [{'tool': f['tool'], 'rule': f['rule'], 'severity': f['severity'],
             'title': f['title'], 'file': f['file'], 'line': f['line'],
             'remediation': f['remediation']}
            for f in findings[:80]]
    return json.dumps({
        'decision': result.get('status'),
        'reasons': result.get('reasons'),
        'viewing_tab': tab,
        'scanners': scanners,
        'coverage': {'covered': sum(1 for x in inv if x.get('status') == 'covered'),
                     'total': len(inv), 'uncovered_inputs': uncovered},
        'defectdojo': dojo,
        'finding_count': len(findings),
        'findings': slim,
    }, indent=1)


def chat(review_id, message, history=None, tab=None, dojo=None):
    """Answer a follow-up question grounded on the review's findings.

    Read-only: never modifies the review, decision, or findings. The
    conversation is stored separately as advisory material.
    """
    cfg = _config()
    if cfg is None:
        raise RuntimeError('AI analyst not configured (no API key)')
    with core.db() as con:
        row = con.execute('SELECT * FROM reviews WHERE id=?', (review_id,)).fetchone()
    if row is None:
        raise ValueError('Review not found')
    if row['status'] not in core.TERMINAL:
        raise ValueError('Review has no terminal decision yet')
    message = (message or '').strip()
    if not message:
        raise ValueError('Message is empty')
    if len(message) > 2000:
        raise ValueError('Message too long (max 2000 chars)')
    history = history or []
    # Keep only the last 10 turns to bound context; sanitize to role/content pairs
    clean_hist = []
    for h in history[-10:]:
        if isinstance(h, dict) and h.get('role') in ('user', 'assistant') and h.get('content'):
            clean_hist.append({'role': h['role'], 'content': str(h['content'])[:2000]})
    context = build_chat_context(json.loads(row['result']), dojo=json.loads(row['dojo'] or '{}') if row['dojo'] else None, tab=tab)
    messages = [
        {'role': 'system', 'content': CHAT_SYSTEM_PROMPT},
        {'role': 'user', 'content': 'Review context:\n' + context},
    ] + clean_hist + [
        {'role': 'user', 'content': message},
    ]
    reply, model = _llm_call(cfg, messages)
    entry = {'role': 'user', 'content': message, 'at': time.time()}
    reply_entry = {'role': 'assistant', 'content': reply, 'at': time.time(), 'model': model}
    path = core.DATA / 'reviews' / review_id / 'ai-chat.json'
    convo = json.loads(path.read_text()) if path.is_file() else []
    convo.extend([entry, reply_entry])
    core.atomic_json(path, convo[-40:])  # keep last 40 messages
    core.audit(review_id, 'analysis.chat', {'model': model})
    return {'reply': reply, 'model': model}


def get_chat(review_id):
    path = core.DATA / 'reviews' / review_id / 'ai-chat.json'
    if path.is_file():
        return json.loads(path.read_text())
    return []


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
