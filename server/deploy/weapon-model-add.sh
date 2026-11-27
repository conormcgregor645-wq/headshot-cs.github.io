#!/usr/bin/env bash
# Подключить свою модель оружия к плагину TASHER Style. В аддоне Мастерской должны лежать модель и свой
# scripts/weapons.vdata_c с записью <vdata> (её собирает PowerShell-скрипт из инструкции).
# Запуск от root:
#   bash weapon-model-add.sh <ключ> "<название>" <knife|pistol|gun> <оружие-основа> <vdata-запись> <путь .vmdl> [номер предмета]
#   нож:      bash weapon-model-add.sh energykukri "Энерго-кукри" knife weapon_knife weapon_tasher_energykukri weapons/nozb1/knife/energy_kukri/energy_kukri_ag2.vmdl 526
#   пистолет: bash weapon-model-add.sh necodeagle "Desert Eagle «Neco»" pistol weapon_deagle weapon_tasher_necodeagle weapons/nozb1/neco_deagle/neco_deagle_ag2.vmdl
# Убрать:  bash weapon-model-add.sh <ключ> --remove        Без перезапуска сервера: NORESTART=1 bash weapon-model-add.sh …
set -euo pipefail
TS=/home/cs2/server/game/csgo/addons/counterstrikesharp/configs/plugins/TasherStyle/TasherStyle.json
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
KEY=${1:-}; NAME=${2:-}; KIND=${3:-}; BASE=${4:-}; VD=${5:-}; MDL=${6:-}; DEF=${7:-0}
[[ "$KEY" =~ ^[a-z0-9_]{1,16}$ ]] || { echo "ключ: латиница в нижнем регистре, цифры, _ (до 16 символов)"; exit 1; }
if [ "$NAME" != "--remove" ]; then
  case "$KIND" in knife) SLOT=2;; pistol) SLOT=1;; gun) SLOT=0;; *) echo "третий параметр: knife, pistol или gun"; exit 1;; esac
  [[ "$BASE" =~ ^weapon_[a-z0-9_]+$ ]] || { echo "оружие-основа: например weapon_knife, weapon_deagle"; exit 1; }
  [[ "$VD" =~ ^[a-z0-9_]{4,63}$ ]] || { echo "vdata-запись: например weapon_tasher_rose"; exit 1; }
  [[ "$MDL" == *.vmdl ]] || { echo "путь к модели .vmdl"; exit 1; }
  [[ "$DEF" =~ ^[0-9]+$ ]] || { echo "номер предмета — число"; exit 1; }
fi
TS="$TS" KEY="$KEY" NAME="$NAME" VD="$VD" MDL="$MDL" BASE="$BASE" SLOT="${SLOT:-2}" DEF="$DEF" python3 - <<'PY'
import json, os
p = os.environ["TS"]
try: j = json.load(open(p, encoding="utf-8"))
except Exception: j = {}
m = j.setdefault("WeaponModels", {})
k = os.environ["KEY"]
if os.environ["NAME"] == "--remove": m.pop(k, None); print("модель оружия", k, "убрана")
else:
    m[k] = {"Name": os.environ["NAME"], "Base": os.environ["BASE"], "Vdata": os.environ["VD"], "Model": os.environ["MDL"], "Slot": int(os.environ["SLOT"]), "Def": int(os.environ["DEF"])}
    print("модель оружия", k, "→", m[k])
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ -n "${NORESTART:-}" ] && { echo "Записано (без перезапуска — в конце: systemctl restart cs2)"; exit 0; }
systemctl restart cs2
echo "Готово."
