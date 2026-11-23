#!/usr/bin/env bash
# Новогодняя карта: сервер CS2 запускается на карте из Мастерской Steam вместо обычной de_dust2.
#   bash /opt/tasher/server/deploy/winter-map.sh <ID карты в Мастерской>   — включить
#   bash /opt/tasher/server/deploy/winter-map.sh off                         — вернуть обычную de_dust2
# ID — число из ссылки на карту: steamcommunity.com/sharedfiles/filedetails/?id=ЧИСЛО
# Если карта не загрузилась за 15 минут (скачивание может занять время), всё возвращается как было.
set -euo pipefail
ARG="${1:-}"
DROP=/etc/systemd/system/cs2.service.d
CONF=$DROP/workshop-map.conf
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "запусти от root"
[ -f /etc/systemd/system/cs2.service ] || die "служба cs2 не установлена (сначала cs2-setup.sh)"

# карта, на которой сервер сейчас (запрос A2S к самому себе)
current_map() {
  node -e 'require("/opt/tasher/server/lib/a2s").info("127.0.0.1",27015,1500).then(i=>console.log(i&&i.map||"")).catch(()=>console.log(""))' 2>/dev/null || true
}

if [ "$ARG" = "off" ]; then
  log "Возвращаю обычную de_dust2"
  rm -f "$CONF"; systemctl daemon-reload; systemctl restart cs2
  echo "готово: сервер перезапускается на de_dust2"; exit 0
fi
[[ "$ARG" =~ ^[0-9]{6,12}$ ]] || die "укажи ID карты из Мастерской (число из ссылки ?id=…) или off"

# команда запуска — та же, что в cs2-setup.sh, только вместо +map de_dust2 — карта из Мастерской
BASE=$(systemctl cat cs2 | grep -E '^ExecStart=/' | tail -1 | sed 's/^ExecStart=//')
[ -n "$BASE" ] || die "не нашёл команду запуска CS2"
NEW=$(printf '%s' "$BASE" | sed -E "s/\+map [^ ]+/+host_workshop_map $ARG/; s/\+host_workshop_map [0-9]+/+host_workshop_map $ARG/")
printf '%s' "$NEW" | grep -q "+host_workshop_map $ARG" || NEW="$BASE +host_workshop_map $ARG"

OLD_CONF=""; [ -f "$CONF" ] && OLD_CONF=$(cat "$CONF")
restore() {
  echo "Возвращаю как было…"
  if [ -n "$OLD_CONF" ]; then printf '%s\n' "$OLD_CONF" > "$CONF"; else rm -f "$CONF"; fi
  systemctl daemon-reload; systemctl restart cs2
}

log "Включаю карту из Мастерской $ARG"
mkdir -p "$DROP"
printf '[Service]\nExecStart=\nExecStart=%s\n' "$NEW" > "$CONF"
systemctl daemon-reload
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart cs2

log "Жду, пока сервер скачает и загрузит карту (до 15 минут)"
OK=""
for i in $(seq 1 90); do
  sleep 10; printf '.'
  M=$(current_map)
  if [ -n "$M" ]; then
    if printf '%s' "$M" | grep -qiE "workshop|$ARG|dust2_|winter|xmas|christmas|new.?year"; then OK="$M"; break; fi
    # сервер поднялся, но на другой карте — Мастерская не отдала карту
    if [ "$i" -gt 12 ]; then echo; echo "сервер работает на «$M», а не на карте из Мастерской"; break; fi
  fi
done; echo
if [ -z "$OK" ]; then
  journalctl -u cs2 --since "$SINCE" --no-pager -o cat | grep -iE "workshop|addon|map|error|fail" | tail -15 | cut -c1-220
  restore; die "карта $ARG не загрузилась — вернул как было. Пришли вывод выше"
fi
echo "готово: сервер на карте «$OK»"
echo "Проверь в игре: карта, бомбплейсы, скины и плагины (!vip, !rank). Вернуть обычную: bash $0 off"
