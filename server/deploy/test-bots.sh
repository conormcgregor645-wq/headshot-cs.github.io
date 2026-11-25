#!/usr/bin/env bash
# Тестовые боты: 5 ботов всегда в команде против людей (люди могут играть и за T, и за CT, и после смены сторон);
# в начале раунда боты переносятся на мид
# (точки мида отмечаешь в игре командой !botmid). Владелец сайта получает в игре права админа (@css/root).
# Запуск от root:  bash test-bots.sh on   — включить
#                  bash test-bots.sh off  — вернуть как было
# Сервер CS2 перезапускается (игроков на нём выкинет).
set -euo pipefail
CSGO=${TASHER_CSGO:-/home/cs2/server/game/csgo}; CSS=$CSGO/addons/counterstrikesharp
CFG=$CSGO/cfg/gamemode_competitive_server.cfg; PL=$CSS/plugins/TasherStyle
MODE=${1:-}
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
[ "$MODE" = on ] || [ "$MODE" = off ] || { echo "используй: bash test-bots.sh on | off"; exit 1; }
[ -f "$PL/TasherStyle.dll" ] || { echo "нет плагина TASHER Style — сначала bash /opt/tasher/server/deploy/vip-setup.sh"; exit 1; }
python3 -c "import sys;sys.exit(0 if 'jointeam'.encode('utf-16-le') in open('$PL/TasherStyle.dll','rb').read() else 1)" \
  || { echo "плагин TASHER Style старый — сначала tasher-update и bash /opt/tasher/server/deploy/vip-setup.sh"; exit 1; }

# 1. настройки ботов — отдельным блоком, чтобы потом убрать без следа
touch "$CFG"
sed -i '/^\/\/ TASHER-TESTBOTS-BEGIN/,/^\/\/ TASHER-TESTBOTS-END/d' "$CFG"
if [ "$MODE" = on ]; then
  cat >>"$CFG" <<'C'
// TASHER-TESTBOTS-BEGIN (bash test-bots.sh off — убрать)
bot_quota 5
bot_quota_mode normal
bot_join_team any
mp_humanteam any
mp_autoteambalance 0
mp_limitteams 0
bot_stop 0
bot_freeze 0
bot_dont_shoot 0
bot_zombie 0
// TASHER-TESTBOTS-END
C
fi
echo "настройки ботов: $([ "$MODE" = on ] && echo 'записаны (5 ботов против людей)' || echo 'убраны')"

# 2. права админа в игре владельцу сайта и включение «ботов на мид»
OWN=$(grep '^OWNER_STEAMIDS=' /etc/tasher.env 2>/dev/null | cut -d= -f2 | tr -d ' "')
MODE="$MODE" OWN="$OWN" ADM="$CSS/configs/admins.json" BM="$PL/botmid.json" python3 - <<'PY'
import json, os, re
mode, own = os.environ["MODE"], [s for s in os.environ["OWN"].split(",") if re.fullmatch(r"7656\d{13}", s)]
adm = os.environ["ADM"]
if mode == "on" and own:
    try: a = json.load(open(adm, encoding="utf-8"))
    except Exception: a = {}
    for i, sid in enumerate(own):
        a[f"tasher_owner_{i + 1}"] = {"identity": sid, "flags": ["@css/root"]}
    json.dump(a, open(adm, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"права админа в игре: владельцев {len(own)}")
elif mode == "on":
    print("ВНИМАНИЕ: в /etc/tasher.env нет OWNER_STEAMIDS — команда !botmid в игре будет недоступна")
bm = os.environ["BM"]
try: d = json.load(open(bm, encoding="utf-8"))
except Exception: d = {"Enabled": False, "Maps": {}}
d["Enabled"] = mode == "on"
d["Opposite"] = mode == "on"
json.dump(d, open(bm, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
pts = sum(len(v) for v in d.get("Maps", {}).values())
print(f"боты против людей и на мид: {'включено' if mode == 'on' else 'выключено'} (сохранённых точек: {pts})")
PY
chown -R cs2:cs2 "$CSS/configs" "$PL" "$CFG"

# 3. перезапуск сервера и проверка
T0=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart cs2
printf 'перезапуск CS2 (до 2 минут)'
for i in $(seq 1 30); do journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -c "Finished loading plugin TASHER Style" >/dev/null && break; sleep 5; printf '.'; done; echo
journalctl -u cs2 --since "$T0" --no-pager -o cat | grep -c "Finished loading plugin TASHER Style" >/dev/null || { echo "ВНИМАНИЕ: TASHER Style не загрузился — запусти tasher-check и пришли вывод"; exit 1; }
sleep 10
cd /opt/tasher/server && sudo -u tasher node --env-file=/etc/tasher.env -e '
const A=require("./lib/a2s"),s=A.parse(process.env.GAME_SERVERS)[0];
(async()=>{for(const c of ["bot_quota","bot_join_team","css_botmid list"]){try{const o=await A.rconExec(s,process.env.GAME_RCON_PASS,c,4000);console.log("> "+c+": "+(o.trim().replace(/\s+/g," ")||"(принято)").slice(0,200))}catch(e){console.log("> "+c+": ошибка "+e.message)}}})()'
if [ "$MODE" = on ]; then
  printf '\n\033[1;32m=== ГОТОВО ===\033[0m\n'
  echo "Зайди на сервер за любую команду — боты встанут за другую. Встань на мид в открытом месте и напиши в чат !botmid"
  echo "Можно отметить несколько точек — боты распределятся. Со следующего раунда они начинают с мида."
  echo "Убрать точки: !botmid clear · выключить: !botmid off · вернуть всё как было: bash test-bots.sh off"
else
  printf '\n\033[1;32m=== ВЕРНУЛ КАК БЫЛО ===\033[0m\n'
fi
