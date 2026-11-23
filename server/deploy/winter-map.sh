#!/usr/bin/env bash
# Новогодняя карта: сервер CS2 играет на карте из Мастерской Steam вместо обычной de_dust2.
#   bash /opt/tasher/server/deploy/winter-map.sh <ID карты в Мастерской>   — включить
#   bash /opt/tasher/server/deploy/winter-map.sh off                         — вернуть обычную de_dust2
#   bash /opt/tasher/server/deploy/winter-map.sh status                      — что включено и на какой карте сервер
# ID — число из ссылки на карту: steamcommunity.com/sharedfiles/filedetails/?id=ЧИСЛО
#
# Как это работает. CS2 входит в Steam только после загрузки первой карты, а карте из Мастерской Steam
# нужен до загрузки: если стартовать сразу на ней (+host_workshop_map вместо +map), сервер ждёт сам себя
# и зависает. Поэтому в команде запуска остаётся +map de_dust2, а в самом конце, после токена,
# добавляется +host_workshop_map <ID>: движок выполняет её сразу после входа в Steam, и сервер
# начинает отвечать игрокам уже на карте из Мастерской (de_dust2 грузится только внутри, пару секунд).
# Карта заранее скачивается через steamcmd; включается без перезапуска — через RCON.
# Таймер tasher-workshop-map раз в минуту возвращает карту, если сервер ушёл с неё (конец матча).
# (служебная команда таймера: winter-map.sh apply)
set -euo pipefail
ARG="${1:-}"
STATE=/etc/tasher/workshop-map
MARK=/run/tasher-workshop-map.last
CSGO=/home/cs2/server/game/csgo
RT=/home/cs2/server/game/bin/linuxsteamrt64
UNIT=tasher-workshop-map
DROP=/etc/systemd/system/cs2.service.d/workshop-map.conf   # команда запуска CS2 с картой из Мастерской
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "запусти от root"

# карта, на которой сервер сейчас (запрос A2S к самому себе); пусто — сервер не отвечает
current_map() {
  node -e 'require("/opt/tasher/server/lib/a2s").info("127.0.0.1",27015,1500).then(i=>console.log(i&&i.map||"")).catch(()=>console.log(""))' 2>/dev/null || true
}
# команда в консоль сервера по RCON; CS2 слушает TCP на адресе имени хоста (часто 127.0.1.1), поэтому пробуем оба
rcon() {
  local pass; pass=$(sed -nE 's/^rcon_password "(.*)"/\1/p' "$CSGO/cfg/server.cfg" | head -1)
  [ -n "$pass" ] || { echo "нет rcon_password в server.cfg" >&2; return 1; }
  RC_PASS="$pass" RC_CMD="$1" node -e '
    const { exec } = require("/opt/tasher/server/lib/rcon");
    (async () => { for (const h of ["127.0.0.1", "127.0.1.1"]) { try { process.stdout.write(await exec(h, 27015, process.env.RC_PASS, process.env.RC_CMD, 4000)); return; } catch (e) {} } process.exit(1); })();'
}
read_state() { ID=""; NAME=""; [ -f "$STATE" ] && . "$STATE"; return 0; }
drop_dropin() { if [ -f "$DROP" ]; then rm -f "$DROP"; systemctl daemon-reload; echo "команда запуска CS2 снова обычная (de_dust2)"; fi; }
# команда запуска из cs2-setup.sh (+map de_dust2 … +sv_setsteamaccount) и в конце — карта из Мастерской
write_dropin() {
  local base; base=$(grep -E '^ExecStart=/' /etc/systemd/system/cs2.service | tail -1 | sed -E 's/^ExecStart=//; s/ \+host_workshop_map [0-9]+//g')
  [ -n "$base" ] || die "не нашёл команду запуска CS2 в cs2.service"
  printf '%s' "$base" | grep -q '+map ' || die "в команде запуска CS2 нет +map — без стартовой карты сервер зависнет"
  mkdir -p "$(dirname "$DROP")"
  printf '[Service]\nExecStart=\nExecStart=%s +host_workshop_map %s\n' "$base" "$1" > "$DROP"
  systemctl daemon-reload
}

case "$ARG" in
apply)
  # раз в минуту из таймера: вернуть карту, если сервер ушёл с неё
  read_state; [ -n "$ID" ] || exit 0
  systemctl is-active --quiet cs2 || exit 0
  M=$(current_map); [ -n "$M" ] || exit 0                       # сервер ещё запускается
  [ "$M" = "$NAME" ] && exit 0
  # недавно уже переключали — карта ещё грузится, не дёргаем сервер повторно
  if [ -f "$MARK" ] && [ $(( $(date +%s) - $(stat -c %Y "$MARK") )) -lt 180 ]; then exit 0; fi
  touch "$MARK"
  echo "сервер на «$M», возвращаю карту из Мастерской $ID («$NAME»)"
  rcon "host_workshop_map $ID" >/dev/null || echo "RCON не ответил — попробую через минуту"
  exit 0 ;;
status)
  read_state
  if [ -n "$ID" ]; then echo "включена карта из Мастерской $ID («$NAME»)"; else echo "карта из Мастерской не включена — обычная de_dust2"; fi
  if [ -f "$DROP" ]; then echo "при запуске CS2: сразу карта $(grep -oE 'host_workshop_map [0-9]+' "$DROP" | cut -d' ' -f2)"; else echo "при запуске CS2: обычная de_dust2"; fi
  echo "таймер: $(systemctl is-active $UNIT.timer 2>/dev/null || true)"
  echo "сервер сейчас на карте: $(current_map)"
  exit 0 ;;
off)
  log "Возвращаю обычную de_dust2"
  rm -f "$STATE" "$MARK"
  systemctl disable --now $UNIT.timer >/dev/null 2>&1 || true
  drop_dropin
  M=$(current_map)
  if [ -n "$M" ] && [ "$M" != de_dust2 ]; then rcon "map de_dust2" >/dev/null || systemctl restart cs2; fi
  echo "готово: сервер на de_dust2, карта из Мастерской больше не включается"; exit 0 ;;
esac
[[ "$ARG" =~ ^[0-9]{6,12}$ ]] || die "укажи ID карты из Мастерской (число из ссылки ?id=…), off или status"
systemctl is-active --quiet cs2 || die "сервер CS2 не запущен (systemctl start cs2)"

log "1/3 Скачиваю карту $ARG через steamcmd (сервер в это время работает как обычно)"
OUT=$(sudo -u cs2 -H /home/cs2/steamcmd/steamcmd.sh +force_install_dir "$RT" +login anonymous +workshop_download_item 730 "$ARG" validate +quit 2>&1 || true)
printf '%s\n' "$OUT" | grep -q "Success. Downloaded item $ARG" || { printf '%s\n' "$OUT" | tail -5; die "steamcmd не скачал карту $ARG (проверь ID и что карта публичная)"; }
echo "скачано: $(du -sh "$RT/steamapps/workshop/content/730/$ARG" | cut -f1)"

log "2/3 Включаю карту на работающем сервере (до 5 минут)"
rm -f "$MARK"; SINCE=$(date '+%Y-%m-%d %H:%M:%S')
rcon "host_workshop_map $ARG" >/dev/null || die "RCON не ответил — карта не включена, сервер как был"
# имя карты — из журнала CS2: «HostStateRequest … addons(ID,…) desc(Changelevel (имя))»; готово, когда сервер на ней
NAME=""
for i in $(seq 1 30); do
  sleep 10; printf '.'
  N=$(journalctl -u cs2 --since "$SINCE" --no-pager -o cat | grep -E "addons\($ARG[,)]" | grep -oE "desc\(Changelevel \([^)]+" | tail -1 | sed 's/.*(//')
  if [ -n "$N" ] && [ "$(current_map)" = "$N" ]; then NAME="$N"; break; fi
done; echo
if [ -z "$NAME" ]; then
  journalctl -u cs2 --since "-6 min" --no-pager -o cat | grep -iE "workshop|addon|$ARG|changelevel|error|fail" | grep -v texturebase | tail -15 | cut -c1-220
  die "карта $ARG не загрузилась за 5 минут — ничего не сохранено, сервер на «$(current_map)». Пришли вывод выше"
fi
echo "сервер на карте «$NAME»"

log "3/3 Сервер всегда запускается сразу на этой карте"
mkdir -p "$(dirname "$STATE")"
printf 'ID=%s\nNAME=%s\n' "$ARG" "$NAME" > "$STATE"
write_dropin "$ARG"
echo "команда запуска CS2: +map de_dust2 … +host_workshop_map $ARG — после перезапуска и перезагрузки VPS сервер сразу на «$NAME»"
cat >/etc/systemd/system/$UNIT.service <<UNITF
[Unit]
Description=TASHER: вернуть карту из Мастерской на сервер CS2
After=cs2.service
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash /opt/tasher/server/deploy/winter-map.sh apply
UNITF
cat >/etc/systemd/system/$UNIT.timer <<UNITF
[Unit]
Description=TASHER: раз в минуту проверять карту из Мастерской
[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNITF
systemctl daemon-reload; systemctl enable --now $UNIT.timer >/dev/null
echo "таймер $UNIT включён: если в конце матча сервер сменит карту, он вернёт её в течение минуты"
echo
echo "Готово: карта «$NAME» ($ARG). Проверь в игре бомбплейсы, скины и плагины (!vip, !rank)."
echo "Что включено: bash $0 status    Вернуть обычную de_dust2: bash $0 off"
