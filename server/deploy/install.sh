#!/usr/bin/env bash
# Установка сайта TASHER на VPS (Ubuntu 22.04/24.04). Запускать от root:
#   bash install.sh tashercs.ru
# Повторный запуск безопасен: обновит сайт, настройки и ключи сохранятся.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
DOMAIN="${1:-tashercs.ru}"; REPO="${REPO:-https://github.com/conormcgregor645-wq/headshot-cs.github.io.git}"
OWNER_DEFAULT="${OWNER:-76561199579039737}"
ENVF=/etc/tasher.env WPCNF=/etc/tasher-wp.cnf

log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "запусти от root"

log "1/7 Пакеты (Node.js 22, Caddy)"
apt-get update -q
apt-get install -y -q curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 >/dev/null
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] && node -e 'require("node:sqlite")' 2>/dev/null; }
# Node.js 22: пробуем несколько источников (часть адресов из России может не открываться)
node_tar() { # $1 — адрес папки с версией
  local sums f d=/usr/local/lib/nodejs
  sums=$(curl -fsSL --connect-timeout 15 "$1/SHASUMS256.txt") || return 1
  f=$(printf '%s\n' "$sums" | grep -o 'node-v22\.[0-9.]*-linux-x64\.tar\.xz' | head -1); [ -n "$f" ] || return 1
  curl -fsSL --connect-timeout 15 -o "/tmp/$f" "$1/$f" || return 1
  (cd /tmp && printf '%s\n' "$sums" | grep " $f\$" | sha256sum -c - >/dev/null) || { echo "контрольная сумма не сошлась"; return 1; }
  rm -rf "$d"; mkdir -p "$d"; tar -xJf "/tmp/$f" -C "$d" --strip-components=1; rm -f "/tmp/$f"
  ln -sf "$d/bin/node" /usr/bin/node; ln -sf "$d/bin/npm" /usr/bin/npm; ln -sf "$d/bin/npx" /usr/bin/npx
}
if ! node_ok; then
  for src in https://nodejs.org/dist/latest-v22.x https://npmmirror.com/mirrors/node/latest-v22.x https://mirrors.huaweicloud.com/nodejs/latest-v22.x; do
    echo "Node.js: пробую $src"; node_tar "$src" && node_ok && break
  done
fi
if ! node_ok && command -v snap >/dev/null; then echo "Node.js: пробую snap"; snap install node --channel=22/stable --classic >/dev/null 2>&1 && ln -sf /snap/bin/node /usr/bin/node || true; fi
node_ok || die "не удалось установить Node.js 22 (сейчас $(node -v 2>/dev/null || echo нет))"
# Caddy: из пакетов Ubuntu, если не вышло — из репозитория Caddy
if ! command -v caddy >/dev/null; then
  apt-get install -y -q caddy >/dev/null 2>&1 || {
    curl -1sLf --connect-timeout 15 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf --connect-timeout 15 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q && apt-get install -y -q caddy >/dev/null
  }
fi
command -v caddy >/dev/null || die "не удалось установить Caddy"
echo "Node.js $(node -v), $(caddy version | cut -d' ' -f1)"

log "2/7 Файлы сайта"
id tasher >/dev/null 2>&1 || useradd --system --home /opt/tasher --shell /usr/sbin/nologin tasher
mkdir -p /var/lib/tasher /var/backups/tasher
if [ -d /opt/tasher/.git ]; then git -C /opt/tasher pull -q --ff-only; else git clone -q --depth 1 "$REPO" /opt/tasher; fi
chown -R tasher:tasher /var/lib/tasher /var/backups/tasher
chown -R root:root /opt/tasher && chmod -R a+rX /opt/tasher
echo "сайт в /opt/tasher ($(git -C /opt/tasher log -1 --format=%h))"

log "3/7 Настройки, ключ Steam, владелец"
touch "$ENVF"; chown root:tasher "$ENVF"; chmod 640 "$ENVF"
setenv() { if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >>"$ENVF"; fi; }
getenv() { grep "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
setenv SITE_URL "https://$DOMAIN"; setenv PORT 8080; setenv HOST 127.0.0.1
setenv DB_PATH /var/lib/tasher/tasher.db; setenv STATIC_DIR /opt/tasher
[ -n "$(getenv START_TK)" ] || setenv START_TK 3000
[ -n "$(getenv OWNER_STEAMIDS)" ] || setenv OWNER_STEAMIDS "$OWNER_DEFAULT"
if [ -z "$(getenv STEAM_API_KEY)" ]; then
  read -rsp "Вставь ключ Steam Web API правой кнопкой мыши и нажми Enter (символы не видны): " KEY </dev/tty; echo
  KEY=$(printf '%s' "$KEY" | tr -cd 'A-Fa-f0-9')
  [ ${#KEY} -eq 32 ] || die "ключ Steam должен быть из 32 символов (0-9, A-F). Проверь и запусти снова"
  setenv STEAM_API_KEY "$KEY"
fi
sed -i '/^DEV_LOGIN=/d' "$ENVF"
IP=$(curl -fsS -4 --connect-timeout 10 ifconfig.me 2>/dev/null || hostname -I | cut -d' ' -f1)
# игровой сервер на этой же машине — показываем его на сайте с живым онлайном
if [ -z "$(getenv GAME_SERVERS)" ] && systemctl list-unit-files cs2.service >/dev/null 2>&1 && [ -f /etc/systemd/system/cs2.service ]; then
  setenv GAME_SERVERS "TASHER Public 5x5|$IP:27015|127.0.0.1:27015"
fi
[ -n "$(getenv GAME_SERVERS)" ] && echo "игровые серверы на сайте: $(getenv GAME_SERVERS | cut -d'|' -f2)"
# ники игроков сайт берёт по RCON (CS2 не отдаёт их в стандартном запросе): новый пароль RCON, общий для сервера и сайта
CFGF=/home/cs2/server/game/csgo/cfg/server.cfg
if [ -z "$(getenv GAME_RCON_PASS)" ] && [ -f "$CFGF" ]; then
  RP=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  sed -i '/^rcon_password /d' "$CFGF"; echo "rcon_password \"$RP\"" >>"$CFGF"
  grep -q '^host_players_show' "$CFGF" || echo 'host_players_show 2' >>"$CFGF"
  [ -f /etc/tasher/cs2.env ] && { grep -v '^RCON_PASS=' /etc/tasher/cs2.env >/etc/tasher/cs2.env.tmp || true; echo "RCON_PASS=$RP" >>/etc/tasher/cs2.env.tmp; cat /etc/tasher/cs2.env.tmp >/etc/tasher/cs2.env; rm -f /etc/tasher/cs2.env.tmp; }
  setenv GAME_RCON_PASS "$RP"
  systemctl restart cs2 2>/dev/null || true
  echo "пароль RCON заменён на новый, игровой сервер перезапущен"
fi
# статистика игроков: сайт читает журнал матча CS2 из консоли сервера
if [ -f "$CFGF" ]; then
  [ -n "$(getenv GAME_LOG_UNIT)" ] || setenv GAME_LOG_UNIT cs2.service
  ADDED=0
  for l in "log on" "mp_logdetail 3" "sv_logfile 1"; do grep -q "^${l%% *} " "$CFGF" || { echo "$l" >>"$CFGF"; ADDED=1; }; done
  [ "$ADDED" = 1 ] && systemctl restart cs2 2>/dev/null || true
  echo "статистика игроков: включена (журнал службы cs2)"
fi
# RCON работает по TCP: снаружи он не нужен, игре хватает UDP
if command -v ufw >/dev/null && ufw status | grep -q "^27015 "; then ufw delete allow 27015 >/dev/null; ufw allow 27015/udp >/dev/null; echo "порт 27015: открыт только UDP (RCON снаружи закрыт)"; fi
echo "владелец: $(getenv OWNER_STEAMIDS), ключ Steam: сохранён"

log "4/7 Связь с игровым сервером (скины в игре)"
if command -v mysql >/dev/null && mysql -N -e "SHOW DATABASES LIKE 'weaponpaints'" 2>/dev/null | grep -q weaponpaints; then
  if [ ! -s "$WPCNF" ]; then
    P=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
    printf '[client]\nuser=tasher\npassword=%s\nhost=127.0.0.1\nport=3306\n' "$P" >"$WPCNF"
  fi
  chown root:tasher "$WPCNF"; chmod 640 "$WPCNF"
  P=$(grep '^password=' "$WPCNF" | cut -d= -f2-)
  mysql <<SQL
CREATE USER IF NOT EXISTS 'tasher'@'localhost' IDENTIFIED BY '$P';
ALTER USER 'tasher'@'localhost' IDENTIFIED BY '$P';
GRANT SELECT, INSERT, UPDATE, DELETE ON weaponpaints.* TO 'tasher'@'localhost';
FLUSH PRIVILEGES;
SQL
  sudo -u tasher mysql --defaults-extra-file="$WPCNF" weaponpaints -N -e "SELECT COUNT(*) FROM wp_player_skins" >/dev/null || die "сайт не может подключиться к базе скинов"
  setenv WP_MYSQL_CNF "$WPCNF"; setenv WP_PAINTS /var/lib/tasher/paints.json
  echo "доступ к базе скинов настроен"
  sudo -u tasher node /opt/tasher/server/deploy/build-paints.js /var/lib/tasher/paints.json || echo "ВНИМАНИЕ: номера раскрасок не скачались, скины в игру пока не пойдут"
else
  echo "база WeaponPaints не найдена — сайт будет работать без передачи скинов в игру"
fi

log "5/7 Служба сайта"
cp /opt/tasher/server/deploy/tasher.service /etc/systemd/system/tasher.service
systemctl daemon-reload && systemctl enable tasher >/dev/null 2>&1 && systemctl restart tasher
sleep 2
curl -fsS http://127.0.0.1:8080/api/health >/dev/null || { journalctl -u tasher -n 40 --no-pager; die "сервер сайта не ответил"; }
journalctl -u tasher -n 5 --no-pager | grep -o "TASHER server.*" | tail -1

log "6/7 HTTPS (Caddy)"
cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
	header Strict-Transport-Security "max-age=31536000"
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF
systemctl enable caddy >/dev/null 2>&1; systemctl reload caddy 2>/dev/null || systemctl restart caddy
ufw allow 80/tcp >/dev/null 2>&1 || true; ufw allow 443/tcp >/dev/null 2>&1 || true

log "7/7 Бэкапы и обновление"
install -m 755 /opt/tasher/server/deploy/backup.sh /usr/local/bin/tasher-backup
install -m 755 /opt/tasher/server/deploy/update.sh /usr/local/bin/tasher-update
echo "17 4 * * * root /usr/local/bin/tasher-backup >/dev/null 2>&1" >/etc/cron.d/tasher-backup
echo "бэкап базы каждую ночь в 04:17, обновление сайта: tasher-update"

printf '\n\033[1;32m=== ГОТОВО ===\033[0m\n'
echo "Сайт работает на этом сервере. Осталось направить домен $DOMAIN сюда:"
echo "  в DNS у регистратора A-запись для @ и для www -> $IP"
echo "HTTPS-сертификат подключится сам через несколько минут после смены DNS."
