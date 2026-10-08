#!/usr/bin/env bash
set -euo pipefail
# Run as root on the assigned Ubuntu host after copying this repository to /opt/tke-governance/src.
base=/opt/tke-governance
getent group tke >/dev/null || groupadd --system tke
id tke >/dev/null 2>&1 || useradd --system --gid tke --home-dir "$base" --shell /usr/sbin/nologin tke
id tke-worker >/dev/null 2>&1 || useradd --system --gid tke --groups docker --home-dir "$base" --shell /usr/sbin/nologin tke-worker
mkdir -p "$base/data" "$base/config/faults"
chown tke:tke "$base/data"
chmod 2770 "$base/data"
chown root:tke "$base/config"
chmod 750 "$base/config"
python3 -m venv "$base/venv"
"$base/venv/bin/pip" install -r "$base/src/requirements.txt"
cp "$base/src/policies/policy-v1.json" "$base/config/"
cp "$base/src/deploy/governance-api.service" "$base/src/deploy/governance-worker.service" /etc/systemd/system/
chown root:tke "$base/config/"*.json
chmod 640 "$base/config/"*.json
systemctl daemon-reload
systemctl enable --now governance-api governance-worker
nginx -t
