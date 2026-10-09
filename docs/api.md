# API contract

The dashboard, component health, and reads of numeric ADO-run reviews (including audit and registered artifacts) are public. Anonymous access excludes host smoke reviews. Valid reviewer tokens scope reads to their registered repositories and can access authorized host tests. `POST /api/v1/reviews` requires Bearer authentication plus HMAC; pipeline credentials are limited to allowlisted repositories and ADO project URL prefixes. Manual analysis generation requires authentication; advisory chat does not change Gate decisions. Lists are limited to the latest 100 visible reviews. API request size is capped at 8 KiB (16 KiB reverse proxy cap).

## POST /api/v1/reviews

```json
{
  "repository": "tke-test",
  "commit_sha": "40-character lowercase Git SHA",
  "policy_version": "policy-v1",
  "ado_run_id": "123",
  "ado_run_url": "https://dev.azure.com/organization/project/_build/results?buildId=123",
  "ref": "refs/heads/main"
}
```

Headers: `Idempotency-Key` (8–160 alphanumeric/colon/underscore/hyphen characters), `X-Timestamp` (Unix seconds within five minutes), `X-Nonce` (32 lowercase hex characters), `X-Signature` (hex HMAC-SHA256).

The signed message is the following exact UTF-8 string, with LF separators and no trailing LF:

```text
POST
/api/v1/reviews
<TIMESTAMP>
<NONCE>
<IDEMPOTENCY_KEY>
<SHA256_OF_RAW_REQUEST_BODY>
```

The HMAC key is distinct from the bearer token. A retry uses a fresh timestamp/nonce/signature, the same idempotency key and equivalent request payload. A changed payload with the same key returns 409. Duplicate nonce returns 409. Unknown repository/ADO project returns 403. Invalid schema returns 422. Bad signature/stale timestamp returns 401. Full queue returns 429.

Successful acceptance returns HTTP 202 and `{ "review_id": "...", "status": "queued" }`. This is not approval.

## GET /api/v1/reviews/{review_id}

Returns status `queued`, `running`, `PASS`, `BLOCK`, or `ERROR`, immutable request identity, request digest, timestamps, and (when terminal) result reasons, findings, scanner metadata, coverage, policy digest, and artifact hashes. Dojo sync status is independent and can change after terminal Gate status.

`GET /api/v1/reviews` lists recent authorized reviews. `GET /api/v1/reviews/{id}/audit` returns the audit trail. `GET /api/v1/reviews/{id}/artifacts/{filename}` allows only registered artifacts and verifies the SHA-256 before download. Unknown or unauthorized review IDs both return 404.

## Client contract

Use `scripts/gate_client.py`. PASS returns 0 and emits an ADO output variable. BLOCK returns 2. ERROR, malformed replies, unknown states, HTTP failures and timeout return 3. The client checks review and commit identity before accepting the decision. Retries are bounded and TLS verification is mandatory.

## AI analyst brief (advisory only)

`POST /api/v1/reviews/{review_id}/analysis` generates a plain-language analyst brief
for a terminal review using an external LLM; `GET /api/v1/reviews/{review_id}/analysis`
retrieves the cached brief. **The brief is now generated automatically** when a review
reaches a terminal decision (the worker triggers it best-effort after the durable
decision is recorded); the manual POST remains as a fallback.

The brief is strictly advisory: it never influences the gate decision, which is
computed deterministically from scanner evidence and policy. Requires the `ai_analyst`
section in server `integrations.json` (base_url, api_key, model); without it the
endpoints return 503/404. The dashboard renders the brief as formatted Markdown
with an explicit "advisory only" label.

## AI chat (advisory only)

`POST /api/v1/reviews/{review_id}/chat` with `{"message": "...", "history": [...], "tab": "findings"}`
asks a follow-up question grounded on the review's full context — decision and reasons,
scanner outcomes, coverage summary, DefectDojo sync state, and findings. The optional
`tab` field tells the analyst which dashboard tab the user is viewing. `GET
/api/v1/reviews/{review_id}/chat` returns the stored conversation. Read-only: the analyst
explains but can never modify the review, its decision, or any finding. History is capped
server-side.

## Component health

`GET /api/v1/components` (public, no auth) returns `{components: [...]}` where each entry is
`{name, status, version, latency_ms, checked_at, error}`. Covers the gate API itself, the
background worker (process check), SonarQube (`/api/system/status`), DefectDojo (HTTP 200/30x),
and the Checkov/Trivy/Gitleaks scanner images (Docker image presence, falling back to the last
terminal review's scanner outcome when the docker socket is not queryable). Every check has a
5s timeout; one component failing never blocks the others. Read-only monitoring only.
