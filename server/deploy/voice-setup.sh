#!/usr/bin/env bash
# Голосовая озвучка серий убийств (First blood, Double kill, Triple kill, Mega kill, Rampage).
# Звуки — из аддона в Мастерской Steam (пак «Announcer kill sounds», CC-BY 3.0, Antti Saari / TripleSnail).
# Скрипт ставит MultiAddonManager (игроки скачивают аддон при входе), подключает аддон и включает голос в TASHER Style.
# Запуск от root:  bash voice-setup.sh <ID аддона в Мастерской>      выключить голос:  bash voice-setup.sh off
set -euo pipefail
CSGO=/home/cs2/server/game/csgo
TS=$CSGO/addons/counterstrikesharp/configs/plugins/TasherStyle/TasherStyle.json
MAMCFG=$CSGO/cfg/multiaddonmanager/multiaddonmanager.cfg
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
ID=${1:-}
[ -n "$ID" ] || { echo "укажи ID аддона: bash voice-setup.sh 1234567890  (или off)"; exit 1; }

set_voice() {
  TS="$TS" V="$1" python3 - <<'PY'
import json, os
p = os.environ["TS"]
try: j = json.load(open(p, encoding="utf-8"))
except Exception: j = {}
j["VoiceEnabled"] = os.environ["V"] == "1"
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

if [ "$ID" = off ]; then
  set_voice 0; systemctl restart cs2; echo "Голос серий выключен — играют встроенные звуки CS2"; exit 0
fi
[[ "$ID" =~ ^[0-9]{6,12}$ ]] || { echo "ID аддона — число из ссылки на Мастерскую (…?id=1234567890)"; exit 1; }

log "1/3 MultiAddonManager (скачивание аддона игроками)"
if [ ! -d "$CSGO/addons/multiaddonmanager" ]; then
  URL=$(curl -fsSL https://api.github.com/repos/Source2ZE/MultiAddonManager/releases/latest | python3 -c 'import json,sys; a=json.load(sys.stdin)["assets"]; print(next(x["browser_download_url"] for x in a if x["name"].endswith(".zip") and "linux" in x["name"].lower()) if any("linux" in x["name"].lower() for x in a) else next(x["browser_download_url"] for x in a if x["name"].endswith(".zip")))')
  T=$(mktemp -d); curl -fsSL "$URL" -o "$T/mam.zip"; unzip -oq "$T/mam.zip" -d "$CSGO"; rm -rf "$T"
  chown -R cs2:cs2 "$CSGO/addons/multiaddonmanager" "$CSGO/cfg/multiaddonmanager" 2>/dev/null || true
  echo "установлен: $URL"
else echo "уже установлен"; fi

log "2/3 Подключаю аддон $ID"
mkdir -p "$(dirname "$MAMCFG")"; touch "$MAMCFG"
CUR=$(sed -nE 's/^mm_extra_addons "([^"]*)".*/\1/p' "$MAMCFG" | head -1)
if [[ ",$CUR," == *",$ID,"* ]]; then NEW=$CUR; else NEW=${CUR:+$CUR,}$ID; fi
if grep -q '^mm_extra_addons' "$MAMCFG"; then sed -i "s/^mm_extra_addons.*/mm_extra_addons \"$NEW\"/" "$MAMCFG"; else echo "mm_extra_addons \"$NEW\"" >>"$MAMCFG"; fi
chown cs2:cs2 "$MAMCFG" 2>/dev/null || true
echo "mm_extra_addons \"$NEW\""

log "3/3 Включаю голос серий в TASHER Style"
set_voice 1
systemctl restart cs2
echo "Готово. Первый заход игрока будет чуть дольше — игра скачает аддон с озвучкой."
