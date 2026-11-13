#!/usr/bin/env bash
# Установка сервера TASHER на чистый VPS (Ubuntu 22.04/24.04 или Debian 12). Запускать от root:
#   bash install.sh tashercs.ru
set -euo pipefail
DOMAIN="${1:-}"; REPO="${REPO:-https://github.com/conormcgregor645-wq/headshot-cs.github.io.git}"
[ -n "$DOMAIN" ] || { echo "Укажи домен: bash install.sh tashercs.ru"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Запусти от root (sudo -i)"; exit 1; }

echo "== 1/6 Пакеты"
apt-get update -y
apt-get install -y curl git sqlite3 ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'require("node:sqlite")' 2>/dev/null || { echo "Нужен Node.js 22.13 или новее (сейчас $(node -v))"; exit 1; }
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "== 2/6 Пользователь и папки"
id tasher >/dev/null 2>&1 || useradd --system --home /opt/tasher --shell /usr/sbin/nologin tasher
mkdir -p /var/lib/tasher /var/backups/tasher
if [ -d /opt/tasher/.git ]; then git -C /opt/tasher pull --ff-only; else git clone --depth 1 "$REPO" /opt/tasher; fi
chown -R tasher:tasher /var/lib/tasher /var/backups/tasher
chown -R root:root /opt/tasher && chmod -R a+rX /opt/tasher

echo "== 3/6 Настройки"
if [ ! -f /etc/tasher.env ]; then
  cat > /etc/tasher.env <<EOF
# Адрес сайта (без / в конце)
SITE_URL=https://$DOMAIN
PORT=8080
HOST=127.0.0.1
DB_PATH=/var/lib/tasher/tasher.db
STATIC_DIR=/opt/tasher
# Ключ Steam Web API: https://steamcommunity.com/dev/apikey (нужен для ников и аватарок)
STEAM_API_KEY=
# SteamID64 владельцев через запятую: им выдаётся роль владельца при входе
OWNER_STEAMIDS=
# Сколько ТК дарить новому игроку при первом входе
START_TK=0
EOF
  chmod 640 /etc/tasher.env && chown root:tasher /etc/tasher.env
  echo "   создан /etc/tasher.env — впиши STEAM_API_KEY и OWNER_STEAMIDS"
fi

echo "== 4/6 Служба"
cp /opt/tasher/server/deploy/tasher.service /etc/systemd/system/tasher.service
systemctl daemon-reload && systemctl enable tasher && systemctl restart tasher

echo "== 5/6 HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
	header Strict-Transport-Security "max-age=31536000"
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF
systemctl enable caddy && systemctl reload caddy || systemctl restart caddy

echo "== 6/6 Бэкапы и обновление"
install -m 755 /opt/tasher/server/deploy/backup.sh /usr/local/bin/tasher-backup
install -m 755 /opt/tasher/server/deploy/update.sh /usr/local/bin/tasher-update
echo "17 4 * * * root /usr/local/bin/tasher-backup >/dev/null 2>&1" > /etc/cron.d/tasher-backup
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi

sleep 1; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo "Сервер работает." || { echo "Сервер не ответил, смотри: journalctl -u tasher -n 50"; exit 1; }
echo
echo "Готово. Осталось:"
echo " 1) nano /etc/tasher.env  — вписать STEAM_API_KEY и OWNER_STEAMIDS, затем: systemctl restart tasher"
echo " 2) В DNS домена $DOMAIN поставить A-запись на IP этого сервера (и www тоже)."
echo "    Сертификат HTTPS Caddy получит сам, как только DNS обновится."
echo " Обновить сайт и сервер позже: tasher-update"
