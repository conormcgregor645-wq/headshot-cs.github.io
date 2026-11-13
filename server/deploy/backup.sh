#!/usr/bin/env bash
# Ежедневная копия базы, хранится 14 дней. Восстановление: остановить службу, распаковать копию в /var/lib/tasher/tasher.db
set -euo pipefail
D=/var/backups/tasher; F="$D/tasher-$(date +%F).db"
sqlite3 /var/lib/tasher/tasher.db ".backup '$F'" && gzip -f "$F"
find "$D" -name 'tasher-*.db.gz' -mtime +14 -delete
