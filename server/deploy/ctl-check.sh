#!/usr/bin/env bash
# Проверка управления сервером с сайта на настоящем CS2: RCON, номера игроков, кик, сообщение в чат, список карт.
# Запуск от root, когда ты сам на сервере:  bash /opt/tasher/server/deploy/ctl-check.sh
# Ничего не меняет в игре, кроме одного кика бота и одного сообщения в чат. Пароли на экран не выводятся.
set -uo pipefail
ENVF=/etc/tasher.env; LIB=/opt/tasher/server/lib; MAPDIR=/home/cs2/server/game/csgo/maps
ok()   { printf '\033[1;32m  OK \033[0m %s\n' "$*"; }
bad()  { printf '\033[1;31m  ОШИБКА \033[0m %s\n' "$*"; FAILS=$((FAILS+1)); }
info() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
FAILS=0
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
getenv() { grep "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
setenv() { if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >>"$ENVF"; fi; }
export RP="$(getenv GAME_RCON_PASS)" GS="$(getenv GAME_SERVERS)"
[ -n "$RP" ] && [ -n "$GS" ] || { echo "в $ENVF нет GAME_RCON_PASS или GAME_SERVERS — сначала запусти install.sh"; exit 1; }
rc() { LIB="$LIB" CMD="$1" node -e '
const A=require(process.env.LIB+"/a2s");const s=A.parse(process.env.GS)[0];
A.rconExec(s,process.env.RP,process.env.CMD,4000).then(o=>{process.stdout.write(o)}).catch(e=>{console.error("RCON: "+e.message);process.exit(2)})'; }

info "1/5 Связь с сервером по RCON"
ST=$(rc status) || { bad "RCON не отвечает (сервер выключен или пароль не совпадает)"; exit 1; }
ok "RCON отвечает"
PL=$(printf '%s' "$ST" | LIB="$LIB" node -e '
const R=require(process.env.LIB+"/rcon");let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const l=R.parseStatus(t);
for(const p of l)console.log([p.id,p.bot?"BOT":"HUMAN",p.n].join("\t"))})')
if [ -z "$PL" ]; then bad "в status нет игроков — зайди на сервер и запусти проверку ещё раз"; exit 1; fi
echo "игроки на сервере (номер, кто, ник):"; printf '%s\n' "$PL" | sed 's/^/    /'
HUM=$(printf '%s\n' "$PL" | awk -F'\t' '$2=="HUMAN"' | head -1)
[ -n "$HUM" ] || { bad "людей на сервере нет — зайди на сервер (при пустом сервере боты спят) и запусти ещё раз"; exit 1; }

info "2/5 Номера игроков в журнале и в status совпадают"
HID=$(printf '%s' "$HUM" | cut -f1); HN=$(printf '%s' "$HUM" | cut -f3)
LOGLINE=$(journalctl -u cs2 --since "-12h" --no-pager -o cat | grep -F "\"$HN<" | grep -F "><[U:1:" | tail -1)
LID=$(printf '%s' "$LOGLINE" | grep -oP '<\K\d+(?=><\[U:1:)' | tail -1)
if [ -z "$LID" ]; then echo "    в журнале нет строк с ником $HN за 12 часов (ник с особыми символами?) — сайт найдёт номер по нику в status"
elif [ "$LID" = "$HID" ]; then ok "номер $HN: в журнале $LID, в status $HID — совпадают"
else bad "номер $HN: в журнале $LID, в status $HID — сайт будет брать номер из status по нику"; fi

info "3/5 Кик (kickid) — на боте"
BOT=$(printf '%s\n' "$PL" | awk -F'\t' '$2=="BOT"' | head -1)
if [ -z "$BOT" ]; then rc "bot_add" >/dev/null; sleep 4; BOT=$(rc status | LIB="$LIB" node -e '
const R=require(process.env.LIB+"/rcon");let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const b=R.parseStatus(t).find(p=>p.bot);if(b)console.log([b.id,"BOT",b.n].join("\t"))})'); fi
if [ -z "$BOT" ]; then bad "ботов нет и добавить не удалось — пропускаю проверку кика"
else
  BID=$(printf '%s' "$BOT" | cut -f1); BN=$(printf '%s' "$BOT" | cut -f3)
  SINCE=$(date '+%Y-%m-%d %H:%M:%S')
  OUT=$(rc "kickid $BID \"TASHER: проверка кика\"")
  if printf '%s' "$OUT" | grep -qi "unknown command"; then bad "сервер не знает kickid: $OUT"
  else
    # сервер отвечает «<ник> kicked by Console» и сразу пишет строку о выходе; журнал systemd может прийти с задержкой
    GONE=""
    if printf '%s' "$OUT" | grep -qiE "kicked by console|\"$BN<$BID><BOT>.*disconnected"; then GONE=1
    else for i in 1 2 3 4 5; do sleep 2; journalctl -u cs2 --since "$SINCE" --no-pager -o cat | grep -F "\"$BN<$BID><BOT>" | grep -q "disconnected" && { GONE=1; break; }; done; fi
    if [ -n "$GONE" ]; then ok "бот $BN (#$BID) выгнан командой kickid — кик и бан с сайта работают"
    else bad "после kickid $BID бот $BN не вышел. Ответ сервера: $(printf '%s' "$OUT" | head -c 200)"; fi
  fi
fi

info "4/5 Сообщение в чат (say)"
OUT=$(rc "say [TASHER] Проверка связи сайта с сервером")
if printf '%s' "$OUT" | grep -qi "unknown command"; then bad "сервер не знает say"; else ok "сообщение отправлено — посмотри чат в игре"; fi

info "5/5 Карты для смены из админки"
MAPS=""
for m in de_mirage de_dust2 de_inferno de_nuke de_ancient de_anubis de_vertigo de_overpass de_train cs_office cs_italy; do
  [ -f "$MAPDIR/$m.vpk" ] && MAPS="$MAPS,$m"
done
for f in "$MAPDIR"/de_*.vpk "$MAPDIR"/cs_*.vpk; do
  [ -f "$f" ] || continue; m=$(basename "$f" .vpk)
  [[ "$m" =~ ^[a-z0-9_]+$ ]] && [[ ! "$m" =~ (_vanity|_preview|_skybox|_[0-9]+$) ]] || continue
  case ",$MAPS," in *",$m,"*) ;; *) MAPS="$MAPS,$m";; esac
done
MAPS=${MAPS#,}
if [ -n "$MAPS" ]; then setenv GAME_MAPS "$MAPS"; ok "карты на сервере: ${MAPS//,/, }"; else echo "    папка карт не найдена — оставлен стандартный список"; fi

systemctl restart tasher; sleep 2
if curl -fsS http://127.0.0.1:8080/api/bans >/dev/null; then ok "сайт перезапущен, банлист отвечает"; else bad "сайт не отвечает после перезапуска: journalctl -u tasher -n 30"; fi
echo
if [ "$FAILS" = 0 ]; then printf '\033[1;32m=== ВСЁ РАБОТАЕТ ===\033[0m\n'; else printf '\033[1;31m=== ОШИБОК: %s — пришли весь вывод ===\033[0m\n' "$FAILS"; fi
