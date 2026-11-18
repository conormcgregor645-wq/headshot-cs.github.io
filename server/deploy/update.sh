#!/usr/bin/env bash
# Обновление сайта и сервера из GitHub
set -euo pipefail
/usr/local/bin/tasher-backup || true
git -C /opt/tasher pull --ff-only
chmod -R a+rX /opt/tasher
# номера раскрасок для скинов в игре (если связь с игровым сервером включена)
if grep -q '^WP_MYSQL_CNF=.' /etc/tasher.env; then sudo -u tasher node /opt/tasher/server/deploy/build-paints.js /var/lib/tasher/paints.json || true; fi
systemctl restart tasher
sleep 1; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo "Обновлено, сервер работает." || { echo "Сервер не ответил: journalctl -u tasher -n 50"; exit 1; }
