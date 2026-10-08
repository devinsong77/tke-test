# TKE Security Delivery Governance

A server-side security review API that gates an Azure DevOps Pipeline. SonarQube, Checkov, Trivy and Gitleaks run on the assigned governance host. Reports are normalized into a fail-closed decision and imported into DefectDojo. The Hosted Agent only submits a signed request and waits for the result.

**Delivery status:** implementation and deployment validation in progress. No real Azure DevOps PASS/BLOCK/ERROR runs have been claimed. See [evidence index](docs/evidence.md) for actual verification and outstanding prerequisites.

## Main chain

`Commit → Build/Test → POST review → server scan → GET terminal decision → Publish only on PASS`

- `PASS`: all mandatory evidence is complete and no blocking rule is violated.
- `BLOCK`: valid evidence contains a prohibited finding or failed Sonar Quality Gate.
- `ERROR`: missing/invalid evidence, scanner failure, identity mismatch or interrupted execution.

The API has a durable queue and audit trail, signed requests, replay protection, repository authorization, idempotency, commit/policy binding, and hash-verified evidence downloads. A read-only dashboard shows the same review, scanner states, coverage, findings, ADO provenance and Dojo sync state.

## Local validation

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

## Deploy and operate

See [operations](docs/operations.md), [architecture and trust boundaries](docs/architecture.md), and [API contract](docs/api.md). Pinned tool deployment is in `deploy/compose.tools.yml`; systemd separates the public API from the Docker-enabled worker. The default policy is `policies/policy-v1.json`.

The original task description remains at `/governance-lab.html` on the assigned host. Service credentials and TLS keys are never part of this repository.

## Azure DevOps setup

1. Create a candidate-owned organization/project and confirm Microsoft-hosted Agent quota.
2. Connect this GitHub repository and select `azure-pipelines.yml`.
3. Add `GATE_URL=https://64.90.11.59:8443`; add secret variables `GATE_TOKEN` and `GATE_HMAC_KEY` from the host's pipeline client configuration.
4. Upload the server's public trust certificate as Secure File `tke-gate-ca.crt`, restricted to this pipeline.
5. Register the exact ADO project URL prefix in the server's repository configuration.
6. Protect main, pipeline changes and secret access; then run real PASS, BLOCK and ERROR scenarios.

Do not use `continueOnError` or change Publish to `always()`. The Publish stage requires successful dependencies and the explicit server PASS output. A real production deployment is not required; this pipeline publishes the approved build artifact.

## Project layout

- `app/api.py`: authentication, request validation, durable submission, evidence endpoints.
- `app/worker.py`: durable execution, recovery and DefectDojo retry.
- `app/scanners.py`: scanner execution and report adapters.
- `app/core.py`: persistence, canonical digests and deterministic policy evaluator.
- `app/static/`: responsive read-only dashboard.
- `scripts/`: client, deployment, integration initialization and backup.
- `tests/`: adversarial API and gate tests.
- `examples/pilot/`: isolated smoke-test source; not a substitute for ADO acceptance.

## Tool licenses

SonarQube Community Build: LGPL-3.0 (with component-specific notices); Checkov: Apache-2.0; Trivy: Apache-2.0; Gitleaks: MIT; DefectDojo: BSD-3-Clause. Verify the licenses and bundled dependencies of the exact pinned release before redistribution. This repository integrates upstream tools; it does not copy their implementation.
