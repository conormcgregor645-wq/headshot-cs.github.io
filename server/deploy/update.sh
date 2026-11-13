#!/usr/bin/env bash
# Обновление сайта и сервера из GitHub
set -euo pipefail
/usr/local/bin/tasher-backup || true
git -C /opt/tasher pull --ff-only
chmod -R a+rX /opt/tasher
systemctl restart tasher
sleep 1; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo "Обновлено, сервер работает." || { echo "Сервер не ответил: journalctl -u tasher -n 50"; exit 1; }
