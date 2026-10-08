#!/usr/bin/env bash
set -euo pipefail
base=/opt/tke-governance
backup_dir="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
trap 'systemctl start governance-api governance-worker' EXIT
systemctl stop governance-api governance-worker
cd "$base"
umask 077
tar -czf "$backup_dir/governance.tar.gz" config data .env
cp /etc/nginx/ssl/fullchain.crt /etc/nginx/ssl/server.key "$backup_dir/"
docker compose -f compose.tools.yml exec -T sonar-db pg_dump -U sonar sonar > "$backup_dir/sonar.sql"
docker compose -f compose.tools.yml exec -T dojo-db pg_dump -U dojo dojo > "$backup_dir/dojo.sql"
docker compose -f compose.tools.yml exec -T uwsgi tar -czf - /app/media > "$backup_dir/dojo-media.tar.gz"
sha256sum "$backup_dir/"* > "$backup_dir/SHA256SUMS"
printf 'Backup created at %s; copy to encrypted off-host storage.\n' "$backup_dir"
