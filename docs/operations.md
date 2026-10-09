# Deployment and operations

## Bootstrap

Target: Ubuntu 24.04, 16 vCPU / 16 GiB RAM. Install `docker.io`, `docker-compose-v2`, `python3-venv`, `git`, `nginx`, and `jq` from the Ubuntu repositories. Set `vm.max_map_count=524288` persistently for SonarQube. Retain the original task page and certificate before modifying the reverse proxy.

1. Copy this project into `/opt/tke-governance/src`.
2. Create `/opt/tke-governance/.env` with unique values for `SONAR_DB_PASSWORD`, `DOJO_DB_PASSWORD`, `DOJO_SECRET_KEY`, `DOJO_AES_KEY` (32 characters), and `DOJO_ADMIN_PASSWORD`. Set mode 600. Never commit this file.
3. Copy `deploy/compose.tools.yml` to `/opt/tke-governance/compose.tools.yml`, then run `docker compose -f compose.tools.yml up -d` there. Wait for initialization and Sonar `/api/system/status=UP`.
4. Run `python3 scripts/init_config.py`, then `bash scripts/bootstrap_host.sh` as root.
5. Run `/opt/tke-governance/venv/bin/python scripts/configure_integrations.py` after both services are ready. Keep generated credentials in the root-managed configuration directory.
6. Configure `repositories.json` with the actual repository and ADO organization/project prefix. For private GitHub repositories, install a read-only deploy credential for the worker; never put it in repository URLs or logs.
7. Install `deploy/nginx.conf` after backing up `/etc/nginx/sites-enabled/governance-lab`. Run `nginx -t` before reloading.
8. Verify HTTPS using the delivered certificate trust file, not `--insecure`.

Endpoints: Dashboard/API `https://64.90.11.59:8443`, DefectDojo `:9443`, SonarQube `:9444`. Tool backend and database ports are not published publicly. The existing self-signed certificate has an IP SAN; explicitly trust its exported public certificate in the client. Do not disable TLS verification.

## Credentials

`config/clients.json` contains distinct pipeline bearer/HMAC secrets and a read-only reviewer token. Deliver reviewer access privately. ADO stores pipeline credentials as secret variables, and the reviewed public trust certificate is versioned at `deploy/tke-gate-ca.crt`. Restrict resource authorization to the intended Pipeline. Tokens are never placed in a URL. The browser retains the read-only token in memory, not localStorage.

The initializer creates service admin credentials. After bootstrap, run `configure_sonar_policy.py`, `configure_sonar_permissions.py`, and `restrict_service_accounts.py` to install the bound Sonar policy and dedicated service identities. The Dojo importer (`governance-importer`) is non-staff and scoped to engagement/scan import; it cannot manage users. SonarQube uses a dedicated `gate-scanner` account holding only the global Execute Analysis permission: it can provision projects and read results, but cannot delete projects or administer the server. The Docker worker is privileged through its socket access and is part of the trusted boundary.

## Diagnosis

- `systemctl status governance-api governance-worker`
- `journalctl -u governance-worker -u governance-api --since '1 hour ago'`
- `docker compose -f compose.tools.yml ps`
- `docker compose -f compose.tools.yml logs --tail 100 sonarqube uwsgi celeryworker`
- Review-specific audit events: authenticated `GET /api/v1/reviews/{id}/audit`.
- Reports: `/opt/tke-governance/data/reviews/{id}/`.

Do not paste secret files or service initialization logs into public issues. Scan stdout is parsed in memory; retained reports strip credential values and source snippets where applicable.

## Recovery

An interrupted running review becomes ERROR on worker startup; its evidence remains. Queued jobs remain queued and resume. Submit a new ADO run after correcting the failure. Repeating a previously accepted request with the same idempotency key returns the same task and never upgrades an old failure to PASS.

Dojo retries use persisted per-tool import state and review-specific engagement/test names. A failure remains `pending_retry`; retries do not change the gate decision. A lost import response is reconciled using reimport into the same named test.

## Backup

Back up configuration secrets, TLS private key, data, Sonar volumes and Dojo volumes to an access-controlled off-host destination. Stop the API and worker for a consistent filesystem snapshot, or use SQLite's backup API for the database and snapshot evidence with it. Use `pg_dump` for both PostgreSQL databases; preserve Dojo media and Sonar extensions. Encrypt backups and test restoration on an isolated host.

The project includes `scripts/backup.sh` for a consistent local backup. It does not replace off-host storage. For restoration, restore configuration and data with original ownership, restore database dumps into matching tool versions, start tools, then API/worker. Confirm old terminal reviews and artifact hashes before accepting new requests.

## Residual risk

One VM is a single failure domain. Disk exhaustion, a root compromise, a scanner exploit, upstream vulnerability-database changes and false negatives remain possible. No external append-only audit store or HA is provided. Pinned versions aid reproduction but still require planned security updates. Review-specific Sonar projects consume storage; retain evidence according to an explicit policy before deleting anything.
