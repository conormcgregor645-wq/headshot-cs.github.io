#!/usr/bin/env bash
# TASHER: установка плагинов и запуск сервера CS2.
# Запуск от root:  bash cs2-setup.sh
# Повторный запуск безопасен: обновит плагины и настройки, токен и пароли сохранятся.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

H=/home/cs2
SRV=$H/server
CSGO=$SRV/game/csgo
ADD=$CSGO/addons
CSS=$ADD/counterstrikesharp
ETC=/etc/tasher
ENVF=$ETC/cs2.env

log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "запусти от root"
[ -x "$SRV/game/cs2.sh" ] || die "CS2 не найден в $SRV — сначала установи игру"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log "1/8 Пакеты"
apt-get update -q
apt-get install -y -q unzip curl jq python3 libicu74 mariadb-server >/dev/null

log "2/8 Токен и пароли"
mkdir -p "$ETC"; chmod 700 "$ETC"; touch "$ENVF"; chmod 600 "$ENVF"
# shellcheck disable=SC1090
. "$ENVF"
if [ -z "${GSLT:-}" ]; then
  read -rsp "Вставь токен сервера (GSLT) правой кнопкой мыши и нажми Enter (символы не видны): " GSLT </dev/tty; echo
  GSLT=$(printf '%s' "$GSLT" | tr -cd 'A-Za-z0-9')
  [ ${#GSLT} -ge 20 ] || die "токен слишком короткий, проверь и запусти скрипт снова"
  echo "GSLT=$GSLT" >>"$ENVF"
fi
gen() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
[ -n "${DB_PASS:-}" ] || { DB_PASS=$(gen); echo "DB_PASS=$DB_PASS" >>"$ENVF"; }
[ -n "${RCON_PASS:-}" ] || { RCON_PASS=$(gen); echo "RCON_PASS=$RCON_PASS" >>"$ENVF"; }
echo "сохранено в $ENVF (доступно только root)"

log "3/8 База данных для скинов"
systemctl enable --now mariadb >/dev/null 2>&1
mysql <<SQL
CREATE DATABASE IF NOT EXISTS weaponpaints CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'wp'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER 'wp'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON weaponpaints.* TO 'wp'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "база weaponpaints готова (доступна только с этого сервера)"

# ---------- загрузка плагинов ----------
asset() { # репозиторий, шаблон имени файла -> ссылка на последний релиз
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" |
    jq -r --arg p "$2" '[.assets[] | select(.name | test($p; "i")) | .browser_download_url][0] // empty'
}
inst() { # имя, ссылка: раскладывает архив плагина по папкам CounterStrikeSharp
  local n=$1 url=$2 d="$TMP/$1" a c p dll
  [ -n "$url" ] || die "$n: не нашёл файл для скачивания"
  rm -rf "$d"; mkdir -p "$d"
  curl -fsSL -o "$d.zip" "$url" || die "$n: не скачался"
  unzip -q -o "$d.zip" -d "$d"
  a=$(find "$d" -maxdepth 3 -type d -name addons | head -1)
  if [ -n "$a" ]; then cp -r "$a" "$CSGO/"; echo "$n: установлен"; return; fi
  c=$(find "$d" -maxdepth 3 -type d -name counterstrikesharp | head -1)
  if [ -n "$c" ]; then cp -r "$c" "$ADD/"; echo "$n: установлен"; return; fi
  p=$(find "$d" -maxdepth 3 -type d \( -name plugins -o -name shared -o -name gamedata \) -printf '%h\n' | head -1)
  if [ -n "$p" ]; then mkdir -p "$CSS"; cp -r "$p"/. "$CSS/"; echo "$n: установлен"; return; fi
  dll=$(find "$d" -name '*.dll' | head -1)
  [ -n "$dll" ] || die "$n: непонятное содержимое архива"
  rm -rf "$CSS/plugins/$n"; mkdir -p "$CSS/plugins"; cp -r "$(dirname "$dll")" "$CSS/plugins/$n"
  echo "$n: установлен"
}

log "4/8 Metamod:Source 2.0"
# свежие сборки 2.0 выкладываются в релизах на GitHub (старый адрес mmsdrop отдаёт устаревшую сборку)
MMURL=$(curl -fsSL "https://api.github.com/repos/alliedmodders/metamod-source/releases?per_page=40" |
  jq -r '[.[] | select(.tag_name | startswith("2.")) | .assets[] | select(.name | test("linux\\.tar\\.gz$")) | .browser_download_url][0] // empty' || true)
[ -n "$MMURL" ] || MMURL="https://github.com/alliedmodders/metamod-source/releases/download/2.0.0.1491/mmsource-2.0.0-git1491-linux.tar.gz"
echo "Metamod: $(basename "$MMURL")"
curl -fsSL -o "$TMP/mm.tgz" "$MMURL" || die "Metamod не скачался"
rm -rf "$ADD/metamod"
mkdir -p "$TMP/mmx"; tar xzf "$TMP/mm.tgz" -C "$TMP/mmx"
[ -d "$TMP/mmx/addons" ] || die "Metamod: в архиве нет папки addons"
cp -r "$TMP/mmx/addons" "$CSGO/"
echo "Metamod установлен"

cat >"$H/patch-gameinfo.py" <<'PY'
# После каждого обновления CS2 Valve перезаписывает gameinfo.gi — возвращаем строку загрузки Metamod
import re, sys
p = "/home/cs2/server/game/csgo/gameinfo.gi"
s = open(p, encoding="utf-8").read()
if "csgo/addons/metamod" not in s:
    s2 = re.sub(r"(\n([ \t]*)Game_LowViolence[^\n]*\n)", lambda m: m.group(1) + m.group(2) + "Game\tcsgo/addons/metamod\n", s, count=1)
    if s2 == s:
        sys.exit("gameinfo.gi: не нашёл строку Game_LowViolence")
    open(p, "w", encoding="utf-8").write(s2)
print("gameinfo.gi: Metamod подключён")
PY
python3 "$H/patch-gameinfo.py"

log "5/8 CounterStrikeSharp и плагины"
inst CounterStrikeSharp "$(asset roflmuffin/CounterStrikeSharp 'with-runtime.*linux.*\.zip$')"
inst AnyBaseLib "$(asset NickFox007/AnyBaseLibCS2 '\.zip$')"
inst PlayerSettings "$(asset NickFox007/PlayerSettingsCS2 '\.zip$')"
inst MenuManager "$(asset NickFox007/MenuManagerCS2 '\.zip$')"
inst WeaponPaints "$(asset Nereziel/cs2-WeaponPaints '^WeaponPaints\.zip$')"
[ -f "$CSS/gamedata/weaponpaints.json" ] || echo "ВНИМАНИЕ: нет gamedata/weaponpaints.json — пришли это сообщение"

log "6/8 Настройки сервера"
mkdir -p "$CSGO/cfg"
cat >"$CSGO/cfg/server.cfg" <<CFG
hostname "TASHER | Public 5x5 | tashercs.ru"
sv_lan 0
sv_password ""
rcon_password "$RCON_PASS"
sv_hibernate_when_empty 1
// список игроков для сайта (запрос Steam A2S_PLAYER)
host_players_show 2
// журнал матча в консоль: из него сайт считает статистику игроков
log on
mp_logdetail 3
sv_logfile 1
CFG
chmod 640 "$CSGO/cfg/server.cfg"
# настройки режима: выполняются после стандартного конфига competitive и перебивают его значения
F="$CSGO/cfg/gamemode_competitive_server.cfg"; touch "$F"
grep -q '^mp_freezetime' "$F" && sed -i 's/^mp_freezetime.*/mp_freezetime 3/' "$F" || echo 'mp_freezetime 3' >>"$F"
# союзники не наносят урон друг другу (в стандартном competitive mp_friendlyfire 1)
grep -q '^mp_friendlyfire' "$F" && sed -i 's/^mp_friendlyfire.*/mp_friendlyfire 0/' "$F" || echo 'mp_friendlyfire 0' >>"$F"
# без автокика за тимкиллы и без бана на перезаход после кика (по умолчанию 15 минут)
grep -q '^mp_autokick' "$F" && sed -i 's/^mp_autokick.*/mp_autokick 0/' "$F" || echo 'mp_autokick 0' >>"$F"
grep -q '^sv_kick_ban_duration' "$F" && sed -i 's/^sv_kick_ban_duration.*/sv_kick_ban_duration 0/' "$F" || echo 'sv_kick_ban_duration 0' >>"$F"

cat >"$H/update.sh" <<'SH'
#!/bin/sh
# обновление CS2 перед каждым запуском + возврат строки Metamod
/home/cs2/steamcmd/steamcmd.sh +force_install_dir /home/cs2/server +login anonymous +app_update 730 +quit || true
python3 /home/cs2/patch-gameinfo.py
SH
chmod 755 "$H/update.sh"
chown -R cs2:cs2 "$H"

cat >/etc/systemd/system/cs2.service <<'UNIT'
[Unit]
Description=TASHER CS2 server
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
User=cs2
Group=cs2
EnvironmentFile=/etc/tasher/cs2.env
WorkingDirectory=/home/cs2/server/game
ExecStartPre=/home/cs2/update.sh
# запуск через cs2.sh от Valve: он подставляет пути к библиотекам, без них Metamod не находит игру
ExecStart=/home/cs2/server/game/cs2.sh -dedicated -console -usercon -port 27015 -maxplayers 10 +game_type 0 +game_mode 1 +map de_dust2 +sv_setsteamaccount ${GSLT}
Restart=always
RestartSec=10
TimeoutStartSec=1800
LimitNOFILE=100000

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/cs2-restart.service <<'UNIT'
[Unit]
Description=Ночной перезапуск CS2 (заодно ставит обновления)
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart cs2.service
UNIT
cat >/etc/systemd/system/cs2-restart.timer <<'UNIT'
[Unit]
Description=Каждую ночь в 05:00
[Timer]
OnCalendar=*-*-* 05:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable cs2.service cs2-restart.timer >/dev/null 2>&1
systemctl start cs2-restart.timer

log "7/8 Первый запуск (создаются файлы настроек плагинов, до 4 минут)"
WPJ="$CSS/configs/plugins/WeaponPaints/WeaponPaints.json"
CORE="$CSS/configs/core.json"
cat >"$H/cssjson.py" <<'PY'
# чтение и правка настроек CounterStrikeSharp: в начале файла бывает строка-комментарий //
import json, re, sys
def load(path):
    t = open(path, encoding="utf-8-sig").read()
    t = re.sub(r"(?m)^\s*//.*$", "", t)
    return json.loads(t)
if __name__ == "__main__":
    try:
        load(sys.argv[1])
    except Exception:
        sys.exit(1)
PY
okjson() { [ -s "$1" ] && python3 "$H/cssjson.py" "$1" 2>/dev/null; }
systemctl stop cs2.service || true
# испорченный или пустой файл удаляем — сервер создаст его заново
for f in "$WPJ" "$CORE"; do if [ -e "$f" ] && ! okjson "$f"; then rm -f "$f"; fi; done
systemctl start cs2.service
for i in $(seq 1 48); do if okjson "$WPJ" && okjson "$CORE"; then break; fi; sleep 5; printf '.'; done; echo
sleep 10   # даём серверу дописать файлы
systemctl stop cs2.service
if ! okjson "$WPJ"; then
  echo "--- последние строки сервера ---"; journalctl -u cs2 -n 60 --no-pager | cut -c1-220
  die "плагин WeaponPaints не создал настройки. Пришли этот вывод целиком"
fi
if ! okjson "$CORE"; then
  if [ -f "$CSS/configs/core.example.json" ]; then cp "$CSS/configs/core.example.json" "$CORE"; else echo '{}' >"$CORE"; fi
fi

DB_PASS="$DB_PASS" WPJ="$WPJ" CORE="$CORE" PYTHONPATH="$H" python3 - <<'PY'
import json, os
from cssjson import load
def edit(path, fn):
    j = load(path)
    fn(j)
    with open(path, "w", encoding="utf-8") as f: json.dump(j, f, ensure_ascii=False, indent=2)
def core(j): j["FollowCS2ServerGuidelines"] = False
def wp(j):
    j.update(DatabaseHost="127.0.0.1", DatabasePort=3306, DatabaseUser="wp", DatabasePassword=os.environ["DB_PASS"],
             DatabaseName="weaponpaints", Website="tashercs.ru")
    a = j.setdefault("Additional", {})
    # скины, ножи, перчатки и агенты надеваются только с сайта: меню выбора в игре выключены
    for k in ["CommandKnife", "CommandMusic", "CommandPin", "CommandGlove", "CommandAgent", "CommandStattrak", "CommandSkinSelection"]:
        a[k] = []
    a.update(CommandSkin=["ws"], CommandRefresh=["wp"], CommandWpEnabled=True, CommandKillEnabled=False,
             GiveRandomKnife=False, GiveRandomSkin=False)
if os.path.exists(os.environ["CORE"]): edit(os.environ["CORE"], core)
else: print("ВНИМАНИЕ: нет core.json")
edit(os.environ["WPJ"], wp)
print("настройки плагинов записаны")
PY
chown -R cs2:cs2 "$H"; chmod 640 "$WPJ"

log "8/8 Запуск с настройками"
systemctl start cs2.service
sleep 75
echo "--- состояние ---"
systemctl is-active cs2.service || true
journalctl -u cs2 --since "-2min" --no-pager | grep -iE "metamod|counterstrikesharp|loaded|plugin|weaponpaints|error|fail|exception|gslt|steam" | grep -viE "steamclient|steamnetworking" | tail -40 | cut -c1-220 || true
J=$(journalctl -u cs2 --since "-3min" --no-pager)
ok() { if printf '%s' "$J" | grep -q "$1"; then echo "  ✔ $2"; else echo "  ✘ $2 — НЕТ"; fi; }
echo "--- итог ---"
ok "Finished loading plugin PlayerSettings" "PlayerSettings"
ok "Finished loading plugin MenuManager" "MenuManager"
ok "Finished loading plugin WeaponPaints" "WeaponPaints"
T=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='weaponpaints'" 2>/dev/null || echo 0)
echo "  таблиц в базе скинов: $T"
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\nАдрес для игры: connect %s:27015\n' "$(curl -fsS -4 ifconfig.me 2>/dev/null || hostname -I | cut -d' ' -f1)"
