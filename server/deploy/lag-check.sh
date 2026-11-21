#!/usr/bin/env bash
# Почему лагает сервер: процессор (в том числе «украденный» хостером), память, диск, сеть, пинг и потери у игроков,
# спам в журнале и ошибки плагинов. Ничего не меняет. Запуск от root:  bash lag-check.sh
# Итог — в /root/tasher-lag.txt (IP скрыты, паролей нет).
set -uo pipefail
OUT=${TASHER_OUT:-/root/tasher-lag.txt}
exec > >(tee "$OUT") 2>&1
mask() { sed -E 's/([0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}/\1.x.x/g'; }
h() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
echo "TASHER lag-check $(date '+%F %T %Z')"

h "1. Процессор (10 секунд замера)"
echo "ядер: $(nproc) · нагрузка: $(cut -d' ' -f1-3 /proc/loadavg)"
vmstat 1 11 | tail -10 | awk '{us+=$13; sy+=$14; id+=$15; wa+=$16; st+=$17; n++} END {printf "в среднем: пользователь %d%%, система %d%%, простой %d%%, ожидание диска %d%%, УКРАДЕНО ХОСТЕРОМ (steal) %d%%\n", us/n, sy/n, id/n, wa/n, st/n; if (st/n >= 10) print ">>> steal большой: хостер отдаёт ядра другим — это и есть лаги, нужен другой тариф/хостер"; if (wa/n >= 10) print ">>> большое ожидание диска"}'
P=$(systemctl show -p MainPID --value cs2 2>/dev/null); CP=$(pgrep -f 'linuxsteamrt64/cs2' | head -1); [ -n "$CP" ] && P=$CP
if [ -n "${P:-}" ] && [ "$P" != 0 ]; then
  echo "CS2 (pid $P):"; top -b -n 2 -d 3 -p "$P" | awk '/PID/{f++} f==2 && $1 ~ /^[0-9]+$/ {print "  загрузка CS2: " $9 "% (100% = одно ядро целиком), память " $10 "%"}'
  echo "самые занятые потоки CS2:"; top -H -b -n 2 -d 3 -p "$P" | awk '/PID/{f++} f==2 && $1 ~ /^[0-9]+$/' | sort -k9 -nr | head -5 | awk '{printf "  %-20s %s%%\n", $12, $9}'
else echo "CS2 не найден среди процессов"; fi
echo "самые тяжёлые процессы:"; ps -eo pcpu,pmem,comm --sort=-pcpu | head -7 | sed 's/^/  /'

h "2. Память и диск"
free -m | awk '/Mem/{printf "память: занято %d из %d МБ, доступно %d МБ\n",$3,$2,$7} /Swap/{printf "подкачка: занято %d из %d МБ%s\n",$3,$2,($3>200?"  >>> сервер уходит в подкачку — это лаги":"")}'
df -h / | awk 'NR==2{print "диск: занято " $5 ", свободно " $4}'

h "3. Сеть сервера"
IF=$(ip route show default | awk '{print $5; exit}')
if [ -n "$IF" ]; then
  read -r r1 t1 <<<"$(awk -v i="$IF:" '$1==i{print $2, $10}' /proc/net/dev)"; sleep 5
  read -r r2 t2 <<<"$(awk -v i="$IF:" '$1==i{print $2, $10}' /proc/net/dev)"
  echo "трафик $IF за 5 с: приём $(( (r2-r1)/5/1024 )) КБ/с, отдача $(( (t2-t1)/5/1024 )) КБ/с"
  awk -v i="$IF:" '$1==i{print "ошибки/потери интерфейса: приём err " $4 " drop " $5 ", отдача err " $12 " drop " $13}' /proc/net/dev
fi
for host in 77.88.8.8 8.8.8.8; do
  ping -c 30 -i 0.2 -W 1 "$host" 2>/dev/null | tail -2 | tr '\n' ' ' | sed -E "s/^/до $host: /" | mask; echo
done
echo "(если потери до 77.88.8.8/8.8.8.8 больше 0–1% — проблема в сети хостера)"

h "4. Игроки: пинг и потери (с точки зрения сервера)"
if [ -f /etc/tasher.env ] && [ -d /opt/tasher/server ]; then
  cd /opt/tasher/server && sudo -u tasher node --env-file=/etc/tasher.env -e '
const A=require("./lib/a2s"),s=A.parse(process.env.GAME_SERVERS)[0];
(async()=>{for(const c of ["status","stats","sv_maxrate","sv_minrate","fps_max","bot_quota"]){try{const o=await A.rconExec(s,process.env.GAME_RCON_PASS,c,5000);console.log("> "+c+"\n"+(o.trim()||"(пусто)").split("\n").slice(0,40).join("\n"))}catch(e){console.log("> "+c+": ошибка "+e.message)}}})()' 2>&1 | mask
fi

h "5. Журнал CS2: спам и ошибки (последние 10 минут)"
J=$(journalctl -u cs2 --since "-10 min" --no-pager -o cat 2>/dev/null)
echo "строк за 10 минут: $(printf '%s\n' "$J" | grep -c .)  (больше ~20 000 — сервер тонет в спаме)"
echo "чаще всего повторяется:"
printf '%s\n' "$J" | sed -E 's/^L [0-9/]+ - [0-9:]+: //; s/[0-9]+/N/g' | cut -c1-110 | sort | uniq -c | sort -nr | head -8 | mask
E=$(printf '%s\n' "$J" | grep -iE 'exception|error|ошибк|stack|warn' | grep -v 'Unknown command')
echo "ошибок/исключений: $(printf '%s\n' "$E" | grep -c .)"
printf '%s\n' "$E" | sed -E 's/[0-9]+/N/g' | cut -c1-160 | sort | uniq -c | sort -nr | head -6 | mask
echo "особых раундов за 10 минут: $(printf '%s\n' "$J" | grep -c 'Особый раунд:')"

h "6. Сайт и база"
for s in tasher mariadb caddy; do printf '%-8s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null)"; done
printf 'ошибок сайта за 10 минут: %s\n' "$(journalctl -u tasher --since '-10 min' --no-pager -o cat 2>/dev/null | grep -ciE 'error|ошибк')"
echo
echo "Готово. Отчёт: $OUT — пришли его целиком или скрины (IP скрыты, паролей нет)."
