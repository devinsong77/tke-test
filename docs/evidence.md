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
