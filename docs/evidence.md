# Evidence index

## Status

All three acceptance paths verified with real Azure DevOps runs against the production gate deployment (revision b72e2fc, https://64.90.11.59:8443).

| Required path | ADO Run | Commit | Review ID | Status |
|---|---|---|---|---|
| PASS → Publish executes | [#20261009.1](https://dev.azure.com/devinsong77-tke/tke-test/_build/results?buildId=1) (main) | `dab03b0` | `83f5f82cee4944c7803469af629ad4f2` | ✅ Verified 2026-10-09: gate PASS, Publish stage ran |
| BLOCK → Publish skipped | [#20261009.2](https://dev.azure.com/devinsong77-tke/tke-test/_build/results?buildId=2) (acceptance/block-synthetic-secret) | `af4693d` | `4bf3baf82df04df584682edda6821677` | ✅ Verified 2026-10-09: gate BLOCK (3 gitleaks findings on synthetic secret), Publish skipped |
| ERROR → Publish skipped | [#20261009.3](https://dev.azure.com/devinsong77-tke/tke-test/_build/results?buildId=3) (acceptance/error-fault-injection) | `4cb7c2b` | `3b41795c36894f6597a4049cac9e6e0d` | ✅ Verified 2026-10-09: gate ERROR (controlled Trivy startup failure), Publish skipped |

## Acceptance run details

### PASS — run #20261009.1 (buildId=1)
- Branch: main, commit `dab03b01d4...` ("Link govgate variable group to pipeline")
- Gate: POST /api/v1/reviews → 202, review_id `83f5f82cee4944c7803469af629ad4f2`; polled to `PASS` ("All required scans completed; no blocking policy violations")
- All four scanners success; DefectDojo synced
- Publish stage: executed (approved-release artifact published)

### BLOCK — run #20261009.2 (buildId=2)
- Branch: acceptance/block-synthetic-secret, commit `af4693df...` (adds SYNTHETIC-SECRET.txt, clearly-marked synthetic credentials, never merged to main)
- Gate: review_id `4bf3baf82df04df584682edda6821677` → `BLOCK`, reasons: ["3 finding(s) violate policy"]
- Blocking findings: gitleaks `generic-api-key` (×2) and `github-pat` (×1) in SYNTHETIC-SECRET.txt
- Gate client exited 2; Publish stage: skipped due to conditions; overall run Failed (expected)

### ERROR — run #20261009.3 (buildId=3)
- Branch: acceptance/error-fault-injection, commit `4cb7c2be...`
- Fault injection: host-admin file `/opt/tke-governance/config/faults/4cb7c2be...` forces the Trivy scanner container to fail at startup (nonexistent entrypoint); the worker records the real nonzero exit and evaluates fail-closed
- Gate: review_id `3b41795c36894f6597a4049cac9e6e0d` → `ERROR`, reasons: ["trivy: Controlled scanner startup failure (missing entrypoint)", "Uncovered input: requirements.txt"]
- Gate client exited 3; Publish stage: skipped due to conditions; overall run Failed (expected)
- DefectDojo: synced (successful scanner imports)

## Verified so far

- SSH login to the assigned host works.
- Azure DevOps org `devinsong77-tke`, project `tke-test`, pipeline `devinsong77.tke-test` bound to GitHub `devinsong77/tke-test`; variable group `govgate` (GATE_URL/GATE_TOKEN/GATE_HMAC_KEY) linked and permitted.
- Microsoft-hosted agent quota: free tier 1 parallel job, 0/1800 min consumed at setup.
- Server deployment: single hardened stack Least-privilege: SonarQube uses dedicated `gate-scanner` account (Execute Analysis only, cannot delete projects or administer); DefectDojo uses non-staff `governance-importer` (engagement/scan import only, cannot manage users). (tke-tools-*); nginx :8443 → governance API :8000; SonarQube :9000, DefectDojo :8080; repo CA cert matches server TLS cert (modulus-verified).
- Ubuntu 24.04, 16 CPU cores, approximately 16 GiB RAM, approximately 93 GiB initially free.
- First 10 local tests passed: authentication, read-only role, signed submission, idempotency conflict, nonce replay, signature tampering, expired request, repository/ADO binding, cross-repository access, fail-closed evaluation and artifact integrity.

## Acceptance procedure

Use separate commits/branches for the three real ADO runs. Keep synthetic secrets off main and out of the PASS branch's reachable history. For ERROR, use a host-admin-only, commit-bound failure injection; capture both the actual scanner failure and the server result. Never use a public force-result endpoint.

For each run collect: triggering commit, full stage screenshot, Run URL/ID, POST/GET logs, review_id, terminal decision, scanner metadata/raw redacted reports, inventory, policy digest, audit trail, Dojo engagement and import state. Record start/submission time in UTC+8, GitHub submission SHA and the deployed revision.

## Pending hardening and limitations

- Replace bootstrap Sonar/Dojo administrator API credentials with least-privilege service accounts.
- Configure private GitHub read access and the actual ADO project binding.
- Verify scanner coverage against reported analyzed files, including all pilot inputs.
- Complete real scan integrations, crash recovery, Dojo retry, and off-host restore demonstrations before claiming full delivery.

## Server smoke evidence (2026-10-08, not ADO acceptance)

| Outcome | Review ID | Source commit | Dojo engagement |
|---|---|---|---|
| PASS | `89583877102d494687cd67788ef5c306` | `f8e7ac8d8f9b803a5f796cfade69d8490c53b795` | 3, all four scanner imports completed |
| BLOCK | `7442acd045054027bdedb0e36b145d74` | `4bd7178784caaf9cf1ebc1bf86069f0ba8f9a403` | 6, all four scanner imports completed |
| ERROR | `10d46c416c32468a94d53b21fcd93cb4` | `8d7ac34a4a178badad18693e8c36c1ce1e3449bb` | 5, available reports imported |

The BLOCK uses a deliberately nonfunctional high-entropy GitHub token pattern in an isolated branch. ERROR executes the real Trivy container with a nonexistent entrypoint and records the actual nonzero startup exit. The worker reports missing dependency coverage and ERROR. Earlier development runs are retained, including failed attempts; they are not acceptance evidence.

The first PASS used Sonar's default Quality Gate. Subsequent reviews bind the explicit `TKE Security Policy` (zero vulnerabilities, zero bugs) into the versioned policy digest. Coverage metrics from executing application tests are not treated as server-side SAST evidence. Unit tests run during normal CI; scanners do not execute untrusted application code on the governance host.

GitHub source: https://github.com/devinsong77/tke-test
Azure DevOps organization/project created: https://dev.azure.com/devinsong77-tke/tke-test
Actual Pipeline setup and Microsoft-hosted quota verification remain in progress.
