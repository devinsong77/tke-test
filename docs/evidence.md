# Evidence index

## Status

Implementation is under validation. The user has not yet registered Azure DevOps. Local/unit or host smoke tests are not represented as real ADO acceptance runs.

| Required path | ADO Run | Commit | Review ID | Evidence | Status |
|---|---|---|---|---|---|
| PASS → Publish executes | Pending | Pending | Pending | Pending | Awaiting ADO setup |
| BLOCK → Publish skipped | Pending | Pending | Pending | Pending | Awaiting ADO setup |
| ERROR → Publish skipped | Pending | Pending | Pending | Pending | Awaiting ADO setup |

## Verified so far

- SSH login to the assigned host works.
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
