#!/usr/bin/env bash
# Повышенный приоритет процесса CS2 на сервере: система реже «отвлекает» игру на другие процессы,
# меньше подвисаний «Long frame … Unaccounted». Перезапускает CS2.
# Запуск от root:  bash cs2-priority.sh       — включить
#                  bash cs2-priority.sh off   — вернуть как было
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
D=/etc/systemd/system/cs2.service.d; F=$D/priority.conf
if [ "${1:-}" = off ]; then
  rm -f "$F"; echo "приоритет CS2: обычный"
else
  mkdir -p "$D"
  cat >"$F" <<'C'
# TASHER: повышенный приоритет игрового сервера (bash cs2-priority.sh off — убрать)
[Service]
Nice=-10
IOSchedulingClass=best-effort
IOSchedulingPriority=0
C
  echo "приоритет CS2: повышенный (nice -10)"
fi
systemctl daemon-reload
T0=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart cs2
printf 'перезапуск CS2'
for i in $(seq 1 30); do journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -q "Finished loading plugin TASHER Style" && break; sleep 5; printf '.'; done; echo
P=$(pgrep -f 'linuxsteamrt64/cs2' | head -1)
[ -n "$P" ] && echo "CS2 работает, nice = $(ps -o ni= -p "$P" | tr -d ' ')" || echo "ВНИМАНИЕ: CS2 не запустился — journalctl -u cs2 -n 50"
echo "Через 10 минут игры проверь: journalctl -u cs2 --since '-10 min' -o cat | grep -ic 'long frame'  (было ~700)"
