#!/usr/bin/env bash
# Замена WeaponPaints на исправленную версию (форк mrc4tt: починены перчатки после обновлений CS2).
# Запуск от root:  bash wp-update.sh
# Делает копию плагина, настроек и базы скинов; если новая версия не загрузится — сам возвращает старую.
set -euo pipefail
CSGO=/home/cs2/server/game/csgo; CSS=$CSGO/addons/counterstrikesharp
PL=$CSS/plugins/WeaponPaints; CFGD=$CSS/configs/plugins/WeaponPaints; WPJ=$CFGD/WeaponPaints.json
REPO="${WP_REPO:-mrc4tt/cs2-WeaponPaints}"
BK=/root/wp-backup-$(date +%Y%m%d-%H%M%S)
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "запусти от root"
[ -d "$PL" ] || die "WeaponPaints не установлен (нет $PL)"
. /etc/tasher/cs2.env

log "1/5 Копия текущей версии"
mkdir -p "$BK"
cp -a "$PL" "$BK/plugin"; [ -d "$CFGD" ] && cp -a "$CFGD" "$BK/config"
[ -f "$CSS/gamedata/weaponpaints.json" ] && cp -a "$CSS/gamedata/weaponpaints.json" "$BK/"
mysqldump weaponpaints >"$BK/weaponpaints.sql"
echo "копия в $BK"

log "2/5 Скачиваю исправленную версию ($REPO)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | jq -r '[.assets[] | select(.name | test("^WeaponPaints.*\\.zip$"; "i")) | .browser_download_url][0] // empty')
[ -n "$URL" ] || die "не нашёл файл релиза"
TAG=$(basename "$(dirname "$URL")"); echo "версия: $TAG"
curl -fsSL -o "$TMP/wp.zip" "$URL"; mkdir "$TMP/x"; unzip -q -o "$TMP/wp.zip" -d "$TMP/x"
echo "в архиве:"; (cd "$TMP/x" && find . -maxdepth 4 -type d | sed 's/^/  /' | head -20)

restore() {
  echo "Возвращаю прежнюю версию…"; systemctl stop cs2 || true
  rm -rf "$PL"; cp -a "$BK/plugin" "$PL"; [ -d "$BK/config" ] && { rm -rf "$CFGD"; cp -a "$BK/config" "$CFGD"; }
  [ -f "$BK/weaponpaints.json" ] && cp -a "$BK/weaponpaints.json" "$CSS/gamedata/"
  chown -R cs2:cs2 /home/cs2; systemctl start cs2; echo "прежняя версия возвращена, база не тронута"
}

log "3/5 Установка"
systemctl stop cs2
rm -rf "$PL"
A=$(find "$TMP/x" -maxdepth 3 -type d -name addons | head -1)
if [ -n "$A" ]; then cp -r "$A" "$CSGO/"
else
  C=$(find "$TMP/x" -maxdepth 3 -type d -name counterstrikesharp | head -1)
  if [ -n "$C" ]; then cp -r "$C" "$CSGO/addons/"
  else D=$(dirname "$(find "$TMP/x" -name 'WeaponPaints.dll' | head -1)"); [ -n "$D" ] && [ "$D" != "." ] || { restore; die "в архиве нет WeaponPaints.dll"; }; mkdir -p "$PL"; cp -r "$D"/. "$PL/"; fi
fi
[ -f "$PL/WeaponPaints.dll" ] || { restore; die "после распаковки нет $PL/WeaponPaints.dll"; }
chown -R cs2:cs2 /home/cs2

log "4/5 Настройки (база, меню выключены — скины только с сайта)"
systemctl start cs2
for i in $(seq 1 36); do [ -s "$WPJ" ] && python3 /home/cs2/cssjson.py "$WPJ" && break; sleep 5; printf '.'; done; echo
sleep 8; systemctl stop cs2
[ -s "$WPJ" ] && python3 /home/cs2/cssjson.py "$WPJ" || { restore; die "новая версия не создала настройки"; }
DB_PASS="$DB_PASS" WPJ="$WPJ" PYTHONPATH=/home/cs2 python3 - <<'PY'
import json, os
from cssjson import load
j = load(os.environ["WPJ"])
j.update(DatabaseHost="127.0.0.1", DatabasePort=3306, DatabaseUser="wp", DatabasePassword=os.environ["DB_PASS"], DatabaseName="weaponpaints", Website="tashercs.ru")
a = j.setdefault("Additional", {})
for k in list(a.keys()):
    if k.startswith("Command") and isinstance(a[k], list) and k not in ("CommandSkin", "CommandRefresh"): a[k] = []
a.update(CommandSkin=["ws"], CommandRefresh=["wp"], CommandWpEnabled=True, CommandKillEnabled=False, GiveRandomKnife=False, GiveRandomSkin=False)
for k in ("KnifeEnabled", "GloveEnabled", "SkinEnabled", "AgentEnabled"):
    if k in a: a[k] = True
json.dump(j, open(os.environ["WPJ"], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("настройки записаны")
PY
chown -R cs2:cs2 /home/cs2; chmod 640 "$WPJ"

log "5/5 Запуск и проверка"
systemctl start cs2
OKL=""
for i in $(seq 1 30); do
  J=$(journalctl -u cs2 --since "-3min" --no-pager -o cat)
  if printf '%s' "$J" | grep -q "Finished loading plugin WeaponPaints"; then OKL=1; break; fi
  if printf '%s' "$J" | grep -q "Failed to load plugin.*WeaponPaints"; then break; fi
  sleep 5; printf '.'
done; echo
if [ -z "$OKL" ]; then
  journalctl -u cs2 --since "-3min" --no-pager -o cat | grep -iE "weaponpaints|exception|error" | tail -15
  restore; die "новая версия не загрузилась — вернул прежнюю. Пришли вывод выше"
fi
echo "WeaponPaints $TAG загружен"
mysql -N -e "SELECT COUNT(*) FROM weaponpaints.wp_player_skins" | sed 's/^/скинов в базе: /'
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\nКопия старой версии: %s\nЗайди на сервер и нажми «Надеть» на перчатках на сайте.\n' "$BK"
