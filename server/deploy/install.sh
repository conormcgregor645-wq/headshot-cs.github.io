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
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
node -e 'require("node:sqlite")' 2>/dev/null || die "нужен Node.js 22.13 или новее (сейчас $(node -v))"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy >/dev/null
fi
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
[ -n "$(getenv START_TK)" ] || setenv START_TK 0
[ -n "$(getenv OWNER_STEAMIDS)" ] || setenv OWNER_STEAMIDS "$OWNER_DEFAULT"
if [ -z "$(getenv STEAM_API_KEY)" ]; then
  read -rsp "Вставь ключ Steam Web API правой кнопкой мыши и нажми Enter (символы не видны): " KEY </dev/tty; echo
  KEY=$(printf '%s' "$KEY" | tr -cd 'A-Fa-f0-9')
  [ ${#KEY} -eq 32 ] || die "ключ Steam должен быть из 32 символов (0-9, A-F). Проверь и запусти снова"
  setenv STEAM_API_KEY "$KEY"
fi
sed -i '/^DEV_LOGIN=/d' "$ENVF"
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

IP=$(curl -fsS -4 ifconfig.me 2>/dev/null || hostname -I | cut -d' ' -f1)
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\n'
echo "Сайт работает на этом сервере. Осталось направить домен $DOMAIN сюда:"
echo "  в DNS у регистратора A-запись для @ и для www -> $IP"
echo "HTTPS-сертификат подключится сам через несколько минут после смены DNS."
