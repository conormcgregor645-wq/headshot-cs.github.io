#!/usr/bin/env bash
# Донастройка игрового сервера: фриз-тайм 3 с, без урона по союзникам, без автокика за тимкиллы, карта до 100 побед без смены сторон и серверная команда обновления скинов для сайта.
# Запуск от root:  bash tune.sh
set -euo pipefail
CSGO=/home/cs2/server/game/csgo; WPJ=$CSGO/addons/counterstrikesharp/configs/plugins/WeaponPaints/WeaponPaints.json
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }

log "1/3 Фриз-тайм 3 секунды, без урона по союзникам"
for f in server.cfg gamemode_competitive_server.cfg; do
  F=$CSGO/cfg/$f; touch "$F"
  if grep -q '^mp_freezetime' "$F"; then sed -i 's/^mp_freezetime.*/mp_freezetime 3/' "$F"; else echo 'mp_freezetime 3' >>"$F"; fi
done
echo "mp_freezetime 3 записан в server.cfg и gamemode_competitive_server.cfg"
# союзники не наносят урон друг другу (в стандартном competitive mp_friendlyfire 1)
F=$CSGO/cfg/gamemode_competitive_server.cfg
if grep -q '^mp_friendlyfire' "$F"; then sed -i 's/^mp_friendlyfire.*/mp_friendlyfire 0/' "$F"; else echo 'mp_friendlyfire 0' >>"$F"; fi
echo "mp_friendlyfire 0 записан в gamemode_competitive_server.cfg — урона по союзникам нет"
# без автокика за тимкиллы и урон по своим и без бана на перезаход после кика (по умолчанию 15 минут)
for k in "mp_autokick 0" "sv_kick_ban_duration 0" "mp_suicide_penalty 0" "mp_suicide_time 0"; do
  n=${k%% *}; if grep -q "^$n" "$F"; then sed -i "s/^$n.*/$k/" "$F"; else echo "$k" >>"$F"; fi
done
echo "mp_autokick 0, sv_kick_ban_duration 0, mp_suicide_penalty 0, mp_suicide_time 0 — за тимкиллы и самоубийства не кикает, не банит и не штрафует"
# длинная карта: без смены сторон, до 100 побед одной из команд (дальше счёт обнуляет плагин TASHER Style)
for k in "mp_maxrounds 201" "mp_halftime 0" "mp_match_can_clinch 0" "mp_overtime_enable 0"; do
  n=${k%% *}; if grep -q "^$n" "$F"; then sed -i "s/^$n.*/$k/" "$F"; else echo "$k" >>"$F"; fi
done
echo "карта до 100 побед без смены сторон (mp_maxrounds 201, mp_halftime 0)"

log "2/3 Команда обновления скинов для сайта"
systemctl stop cs2
WPJ="$WPJ" PYTHONPATH=/home/cs2 python3 - <<'PY'
import json, os, secrets
from cssjson import load
p = os.environ["WPJ"]; j = load(p); a = j.setdefault("Additional", {})
# меню выбора в игре закрыты: пустой список команд ломает новую версию плагина (SetupKnifeMenu),
# поэтому командам меню даём случайные имена, которые игрок не угадает. Скины выбираются только на сайте.
keep = {"CommandSkin": ["ws"], "CommandRefresh": ["wp"], "CommandRefreshAdmin": ["wp_refresh"]}
for k in list(a.keys()):
    if k.startswith("Command") and isinstance(a[k], list) and k not in keep:
        a[k] = ["off" + secrets.token_hex(6)]
a.update(keep)
a.update(CommandWpEnabled=True, CommandKillEnabled=False, GiveRandomKnife=False, GiveRandomSkin=False)
for k in ("KnifeEnabled", "GloveEnabled", "SkinEnabled", "AgentEnabled"):
    if k in a: a[k] = True
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("настройки WeaponPaints: команды меню скрыты, css_wp_refresh включена")
PY
chown -R cs2:cs2 /home/cs2
T0=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start cs2

log "3/3 Проверка (сервер запускается, до 2 минут)"
for i in $(seq 1 24); do journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -q "Finished loading plugin WeaponPaints" && break; sleep 5; printf '.'; done; echo
sleep 8
if journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -q "Error while loading required plugins"; then
  echo "ВНИМАНИЕ: WeaponPaints снова сообщает об ошибке:"; journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -B2 -A25 "Error while loading required plugins" | cut -c1-230 | head -40
else echo "WeaponPaints загрузился без ошибок"; fi
OWN=$(grep '^OWNER_STEAMIDS=' /etc/tasher.env | cut -d= -f2 | cut -d, -f1)
cd /opt/tasher/server && sudo -u tasher node --env-file=/etc/tasher.env -e '
const A=require("./lib/a2s"),s=A.parse(process.env.GAME_SERVERS)[0];
(async()=>{for(const c of ["mp_freezetime","css_wp_refresh '"$OWN"'"]){try{const o=await A.rconExec(s,process.env.GAME_RCON_PASS,c,4000);console.log("> "+c+"\n"+(o.trim()||"(пустой ответ — команда принята)").slice(0,300))}catch(e){console.log("> "+c+": ошибка "+e.message)}}})()'
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\n'
