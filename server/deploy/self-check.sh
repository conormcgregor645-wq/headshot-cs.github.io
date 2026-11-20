#!/usr/bin/env bash
# Самопроверка сервера TASHER: сайт, CS2, плагины, база, связь сайта с игрой, ТК и задания.
# Запуск от root:  tasher-check   (или  bash /opt/tasher/server/deploy/self-check.sh)
# Ничего не меняет. Пароли не выводятся, IP-адреса в отчёте скрыты. Отчёт сохраняется в /root/tasher-check.txt
set -uo pipefail
ENVF=${TASHER_ENV:-/etc/tasher.env}; APP=${TASHER_APP:-/opt/tasher}; LIB=$APP/server/lib
CSS=${TASHER_CSS:-/home/cs2/server/game/csgo/addons/counterstrikesharp}; SITE=${TASHER_SITE:-http://127.0.0.1:8080}
OUTF=${TASHER_OUT:-/root/tasher-check.txt}
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }

main() {
FAILS=0; WARNS=0
ok()   { printf '  \033[1;32mOK\033[0m      %s\n' "$*"; }
bad()  { printf '  \033[1;31mОШИБКА\033[0m  %s\n' "$*"; FAILS=$((FAILS+1)); }
warn() { printf '  \033[1;33mВНИМАНИЕ\033[0m %s\n' "$*"; WARNS=$((WARNS+1)); }
note() { printf '          %s\n' "$*"; }
head_() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
getenv() { grep "^$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-; }
sq() { mysql -N -B -e "$1" 2>/dev/null; }

printf 'Проверка TASHER — %s\n' "$(date '+%d.%m.%Y %H:%M:%S %Z')"

# ---------------------------------------------------------------- 1
head_ "1/7 Сервер (железо)"
CPU=$(nproc); MEMT=$(free -m | awk '/^Mem:/{print $2}'); MEMA=$(free -m | awk '/^Mem:/{print $7}')
DISKP=$(df -P / | awk 'NR==2{gsub("%","",$5);print $5}'); DISKF=$(df -Ph / | awk 'NR==2{print $4}')
LOAD=$(cut -d' ' -f1-3 /proc/loadavg)
note "ядер: $CPU · память: свободно $MEMA из $MEMT МБ · диск: занято $DISKP%, свободно $DISKF · нагрузка: $LOAD"
[ "$MEMA" -ge 400 ] && ok "памяти хватает" || warn "свободной памяти мало ($MEMA МБ)"
[ "$DISKP" -le 90 ] && ok "места на диске хватает" || warn "диск почти заполнен ($DISKP%)"

# ---------------------------------------------------------------- 2
head_ "2/7 Сайт"
if systemctl is-active --quiet tasher; then ok "служба сайта работает"; else bad "служба сайта не запущена: journalctl -u tasher -n 30"; fi
H=$(curl -fsS -m 5 $SITE/api/health 2>/dev/null)
printf '%s' "$H" | grep -q '"ok":true' && ok "сайт отвечает" || bad "сайт не отвечает на /api/health"
if [ -d $APP/.git ]; then
  LOC=$(git -C "$APP" rev-parse --short HEAD 2>/dev/null)
  if timeout 20 git -C "$APP" fetch -q origin 2>/dev/null; then
    REM=$(git -C "$APP" rev-parse --short origin/main 2>/dev/null || git -C "$APP" rev-parse --short FETCH_HEAD)
    [ "$LOC" = "$REM" ] && ok "версия сайта свежая ($LOC)" || warn "на сервере версия $LOC, на GitHub новее ($REM) — запусти tasher-update"
  else note "версия сайта $LOC (GitHub не ответил — сверить не удалось)"; fi
fi
Q=$(curl -fsS -m 5 $SITE/api/quests 2>/dev/null)
if printf '%s' "$Q" | jq -e '.quests.list | length == 3' >/dev/null 2>&1; then
  ok "задания дня: $(printf '%s' "$Q" | jq -r '[.quests.list[].n] | join(" · ")')"
else bad "задания дня не отдаются (/api/quests) — сайт старой версии? запусти tasher-update"; fi
ST=$(curl -fsS -m 5 $SITE/api/statuses 2>/dev/null | jq '.statuses | length' 2>/dev/null)
[ -n "$ST" ] && ok "статусов на сайте сейчас: $ST" || bad "сайт не отдаёт статусы"
SV=$(curl -fsS -m 8 $SITE/api/servers 2>/dev/null | jq -r '.servers[] | "\(.name // "сервер"): \(if .online == false then "выключен" else "\(.players // 0)/\(.max // 0) игроков, карта \(.map // "?")" end)"' 2>/dev/null)
[ -n "$SV" ] && ok "список серверов на сайте: $(printf '%s' "$SV" | paste -sd ';' -)" || warn "сайт не показывает серверы (/api/servers пуст)"
STK=$(getenv START_TK); [ "${STK:-0}" -gt 0 ] 2>/dev/null && ok "бонус новым игрокам: $STK ТК" || warn "бонус новым игрокам выключен (START_TK=${STK:-0}) — его включает vip-setup.sh"

# ---------------------------------------------------------------- 3
head_ "3/7 Игровой сервер CS2"
if systemctl is-active --quiet cs2; then ok "служба CS2 работает"; else bad "служба CS2 не запущена: systemctl status cs2"; fi
STARTED=$(systemctl show cs2 -p ActiveEnterTimestamp --value 2>/dev/null)
SINCE=""; [ -n "$STARTED" ] && SINCE="@$(date -d "$STARTED" +%s 2>/dev/null)"
[ -n "$STARTED" ] && note "запущен: $STARTED"
J=$(journalctl -u cs2 ${SINCE:+--since "$SINCE"} --no-pager -o cat 2>/dev/null)
RP="$(getenv GAME_RCON_PASS)"; GS="$(getenv GAME_SERVERS)"
rc() { LIB="$LIB" RP="$RP" GS="$GS" CMD="$1" node -e '
const A=require(process.env.LIB+"/a2s");const s=A.parse(process.env.GS)[0];
A.rconExec(s,process.env.RP,process.env.CMD,4000).then(o=>{process.stdout.write(o)}).catch(e=>{console.error(e.message);process.exit(2)})' 2>/dev/null; }
if [ -n "$RP" ] && [ -n "$GS" ]; then
  STAT=$(rc status)
  if [ -n "$STAT" ]; then
    ok "RCON отвечает (сайт может управлять сервером)"
    PL=$(printf '%s' "$STAT" | LIB="$LIB" node -e 'const R=require(process.env.LIB+"/rcon");let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const l=R.parseStatus(t);console.log(l.filter(p=>!p.bot).length+" "+l.filter(p=>p.bot).length)})' 2>/dev/null)
    note "сейчас на сервере: людей ${PL%% *}, ботов ${PL##* }"
    MAP=$(printf '%s' "$STAT" | grep -oP 'loaded spawngroup\(\s*1\)\s*:\s*SV:\s*\[1:\s*\K[a-z0-9_]+' | head -1)
    [ -n "$MAP" ] && note "карта: $MAP"
  else bad "RCON не отвечает — сайт не сможет кикать, банить и применять статусы сразу"; fi
else bad "в $ENVF нет GAME_RCON_PASS или GAME_SERVERS"; fi

# ---------------------------------------------------------------- 4
head_ "4/7 Плагины"
LOADED=$(printf '%s\n' "$J" | grep -oP 'Finished loading plugin \K.*' | sort -u)
FAILED=$(printf '%s\n' "$J" | grep -E "Failed to load plugin" | sort -u)
if [ -n "$FAILED" ]; then bad "плагины с ошибкой загрузки:"; printf '%s\n' "$FAILED" | cut -c1-200 | sed 's/^/            /'; fi
has() { printf '%s\n' "$LOADED" | grep -qiE "$1"; }
has "^TASHER Style" && ok "TASHER Style загружен" || bad "TASHER Style не загружен — запусти vip-setup.sh"
VER=$(python3 - "$CSS/plugins/TasherStyle/TasherStyle.dll" <<'PY' 2>/dev/null
import sys,re
b=open(sys.argv[1],'rb').read()
for v in ("1.2.0","1.1.0","1.0.0"):
    if v.encode('utf-16-le') in b: print(v); break
PY
)
case "$VER" in
  1.2.0) ok "версия TASHER Style 1.2.0 (эффекты, !rank !top !tk !quests, приветствие)";;
  "") warn "не удалось узнать версию TASHER Style";;
  *) bad "TASHER Style старой версии ($VER) — запусти vip-setup.sh";;
esac
NV=$(printf '%s\n' "$LOADED" | grep -c '^\[VIP\]')
[ "$NV" -ge 11 ] && ok "VIP: ядро и модули загружены ($NV шт.)" || bad "VIP загружен не полностью ($NV из 11) — запусти vip-setup.sh"
has "weapon ?paints" && ok "WeaponPaints (скины) загружен" || bad "WeaponPaints не загружен — скины с сайта не применятся"
CNT=$(printf '%s\n' "$LOADED" | grep -c .)
note "всего загружено плагинов: $CNT"
ERRS=$(printf '%s\n' "$J" | grep -iE "\[(TASHER|VIP)|TasherStyle|VIPCore|WeaponPaints" | grep -iE "exception|error|ошибк|не удалось|недоступна" | tail -8)
[ -z "$ERRS" ] && ok "ошибок плагинов в журнале нет" || { bad "ошибки плагинов в журнале (последние):"; printf '%s\n' "$ERRS" | cut -c1-220 | sed 's/^/            /'; }
CFG=$CSS/configs/plugins/TasherStyle/TasherStyle.json
[ -f "$CFG" ] && jq -e '.Password|length>0' "$CFG" >/dev/null 2>&1 && ok "настройки TASHER Style на месте" || bad "нет настроек TASHER Style ($CFG) — запусти vip-setup.sh"

# ---------------------------------------------------------------- 5
head_ "5/7 База игры (статусы, стили, данные для команд)"
if ! sq "SELECT 1" >/dev/null; then bad "MySQL не отвечает"; else
  T=$(sq "SELECT GROUP_CONCAT(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME IN ('vip_users','tasher_style','tasher_player','tasher_top','wp_player_skins')")
  for t in vip_users tasher_style tasher_player tasher_top wp_player_skins; do
    case ",$T," in *",$t,"*) ;; *) bad "нет таблицы $t";; esac
  done
  FX=$(sq "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME='tasher_style' AND COLUMN_NAME IN ('kill_fx','kill_snd','trail','tracer')")
  [ "$FX" = 4 ] && ok "таблицы на месте, колонки эффектов есть" || bad "в tasher_style нет колонок эффектов — запусти vip-setup.sh"
  DBV=$(sq "SELECT COUNT(*) FROM weaponpaints.vip_users WHERE sid=0")
  if [ -n "$ST" ] && [ -n "$DBV" ]; then
    [ "$ST" = "$DBV" ] && ok "статусы: на сайте $ST, в игре $DBV — совпадают" || warn "статусы: на сайте $ST, в игре $DBV (сайт сверяет раз в минуту — проверь ещё раз через минуту)"
  fi
  NS=$(sq "SELECT COUNT(*) FROM weaponpaints.tasher_style"); note "стилей в игре (теги, цвета, дым, эффекты): ${NS:-0}"
  FXN=$(sq "SELECT SUM(kill_fx<>'')+0, SUM(kill_snd<>'')+0, SUM(tracer<>'')+0, SUM(trail<>'')+0, SUM(smoke<>'')+0 FROM weaponpaints.tasher_style" 2>/dev/null)
  [ -n "$FXN" ] && note "надето эффектов: убийство $(echo $FXN|cut -d' ' -f1), звук $(echo $FXN|cut -d' ' -f2), трассеры $(echo $FXN|cut -d' ' -f3), след гранат $(echo $FXN|cut -d' ' -f4), дым $(echo $FXN|cut -d' ' -f5)"
  NP=$(sq "SELECT COUNT(*) FROM weaponpaints.tasher_player"); NT=$(sq "SELECT COUNT(*) FROM weaponpaints.tasher_top")
  NQ=$(sq "SELECT COUNT(*) FROM weaponpaints.tasher_player WHERE quests LIKE '{\"l\":[%'")
  if [ "${NP:-0}" -gt 0 ]; then ok "данные для !rank/!tk/!quests: игроков $NP (с заданиями $NQ), топ-10: $NT строк"
  elif [ "${ST:-0}" -gt 0 ]; then bad "сайт не пишет данные для команд в игре (tasher_player пуст) — journalctl -u tasher | grep info"
  else warn "данных для команд пока нет (на сервере никого и статусов нет)"; fi
  NW=$(sq "SELECT COUNT(DISTINCT steamid) FROM weaponpaints.wp_player_skins"); note "игроков со скинами с сайта: ${NW:-0}"
fi

# ---------------------------------------------------------------- 6
head_ "6/7 ТК за игру, задания, Фортуна (сегодня)"
DBP=$(getenv DB_PATH); DBP=${DBP:-/var/lib/tasher/tasher.db}
if [ -f "$DBP" ]; then
  REP=$(DBP="$DBP" node --no-warnings -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DBP);db.exec("PRAGMA busy_timeout=5000");
const day=new Date(Date.now()+3*3600e3).toISOString().slice(0,10),start=new Date(day+"T00:00:00Z").getTime()-3*3600e3;
const one=(q,...a)=>{try{return db.prepare(q).get(...a)}catch(e){return null}};
const g=one("SELECT COUNT(*) n, COALESCE(SUM(delta),0) s FROM ledger WHERE kind=? AND created_at>=?","game",start)||{n:0,s:0};
const q=one("SELECT COUNT(*) n, COALESCE(SUM(delta),0) s FROM ledger WHERE kind=? AND created_at>=?","quest",start)||{n:0,s:0};
const pr=one("SELECT COUNT(DISTINCT sid) n, COALESCE(SUM(done),0) d FROM quest_prog WHERE day=? AND qid<>?",day,"all")||{n:0,d:0};
const ed=one("SELECT COUNT(*) n, COALESCE(SUM(base),0) s FROM earn_day WHERE day=?",day)||{n:0,s:0};
const pl=one("SELECT COUNT(*) n FROM gplayers WHERE last_seen>=?",start)||{n:0};
const wh=one("SELECT COUNT(*) n FROM wheel WHERE last=?",day)||{n:0};
const nu=one("SELECT COUNT(*) n FROM users WHERE created_at>=?",start)||{n:0};
const sh=one("SELECT COUNT(*) n, COALESCE(-SUM(delta),0) s FROM ledger WHERE kind=? AND created_at>=?","shop",start)||{n:0,s:0};
console.log([pl.n,ed.n,ed.s,g.n,g.s,pr.n,pr.d,q.n,q.s,wh.n,nu.n,sh.n,sh.s].join(" "))' 2>/dev/null)
  if [ -n "$REP" ]; then
    set -- $REP
    note "сегодня играли: $1 · заработали ТК за игру: $2 игроков (до множителя $3 ТК), зачислено $4 раз на $5 ТК"
    note "задания: прогресс у $6 игроков, выполнено $7, выплачено $8 раз на $9 ТК"
    note "Фортуна: прокруток ${10} · новых игроков на сайте: ${11} · покупок в магазине: ${12} на ${13} ₽"
    if [ "$1" -gt 0 ] && [ "$2" = 0 ]; then bad "сегодня на сервере играли, но ТК за игру не начислялись — journalctl -u tasher | grep earn"
    elif [ "$1" -gt 0 ]; then ok "ТК за игру начисляются"; else note "сегодня на сервере ещё не играли — ТК и задания проверятся после игры"; fi
    if [ "$1" -gt 0 ] && [ "$6" = 0 ]; then warn "сегодня играли, но прогресса по заданиям нет — сыграй пару раундов и проверь ещё раз"
    elif [ "$6" -gt 0 ]; then ok "задания считаются"; fi
  else bad "не удалось прочитать базу сайта ($DBP)"; fi
else bad "нет базы сайта $DBP"; fi

# ---------------------------------------------------------------- 7
head_ "7/7 Журнал сайта (ошибки за 24 часа)"
SJ=$(journalctl -u tasher --since "-24h" --no-pager -o cat 2>/dev/null | grep -iE "error|ошибк|не прошла|не удалось|exception|ECONN|EPIPE" | grep -v "ExperimentalWarning" | tail -8)
[ -z "$SJ" ] && ok "ошибок нет" || { warn "в журнале сайта есть ошибки (последние):"; printf '%s\n' "$SJ" | cut -c1-220 | sed 's/^/            /'; }
for k in vip style info; do
  L=$(journalctl -u tasher --since "-24h" --no-pager -o cat 2>/dev/null | grep -F "[$k]" | tail -1)
  [ -n "$L" ] && note "последнее [$k]: $(printf '%s' "$L" | cut -c1-160)"
done

echo
if [ "$FAILS" = 0 ] && [ "$WARNS" = 0 ]; then printf '\033[1;32m=== ВСЁ В ПОРЯДКЕ ===\033[0m\n'
elif [ "$FAILS" = 0 ]; then printf '\033[1;33m=== ОШИБОК НЕТ, ЗАМЕЧАНИЙ: %s ===\033[0m\n' "$WARNS"
else printf '\033[1;31m=== ОШИБОК: %s, ЗАМЕЧАНИЙ: %s ===\033[0m\n' "$FAILS" "$WARNS"; fi
echo "Отчёт сохранён в $OUTF — пришли его целиком (паролей в нём нет, IP скрыты)."
}

# IP-адреса в отчёте прячем; отчёт пишем и на экран, и в файл (без цветов)
main 2>&1 | sed -E 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]+)?\b/x.x.x.x\2/g' | tee >(sed -E 's/\x1b\[[0-9;]*m//g' > "$OUTF")
sleep 0.3
