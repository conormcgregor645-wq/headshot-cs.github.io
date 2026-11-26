#!/usr/bin/env bash
# Подключить свою модель оружия (пока — ножа) к плагину TASHER Style. В аддоне Мастерской должны лежать модель
# и свой scripts/weapons.vdata_c с записью <vdata> (см. инструкцию на сайте/в чате).
# Запуск от root:  bash weapon-model-add.sh <ключ> "<название>" <vdata-запись> <путь .vmdl> [оружие-основа]
#   пример: bash weapon-model-add.sh rose "Нож «Роза»" weapon_knife_rose weapons/nozb1/knife/blooming_rose/blooming_rose_ag2.vmdl
# Убрать:  bash weapon-model-add.sh <ключ> --remove
set -euo pipefail
TS=/home/cs2/server/game/csgo/addons/counterstrikesharp/configs/plugins/TasherStyle/TasherStyle.json
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
KEY=${1:-}; NAME=${2:-}; VD=${3:-}; MDL=${4:-}; BASE=${5:-weapon_knife}
[[ "$KEY" =~ ^[a-z0-9_]{1,16}$ ]] || { echo "ключ: латиница в нижнем регистре, цифры, _ (до 16 символов)"; exit 1; }
if [ "$NAME" != "--remove" ]; then
  [[ "$VD" =~ ^[a-z0-9_]{4,63}$ ]] || { echo "vdata-запись: например weapon_knife_rose"; exit 1; }
  [[ "$MDL" == *.vmdl ]] || { echo "путь к модели .vmdl"; exit 1; }
fi
TS="$TS" KEY="$KEY" NAME="$NAME" VD="$VD" MDL="$MDL" BASE="$BASE" python3 - <<'PY'
import json, os
p = os.environ["TS"]
try: j = json.load(open(p, encoding="utf-8"))
except Exception: j = {}
m = j.setdefault("WeaponModels", {})
k = os.environ["KEY"]
if os.environ["NAME"] == "--remove": m.pop(k, None); print("модель оружия", k, "убрана")
else:
    m[k] = {"Name": os.environ["NAME"], "Base": os.environ["BASE"], "Vdata": os.environ["VD"], "Model": os.environ["MDL"], "Slot": 2}
    print("модель оружия", k, "→", m[k])
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
systemctl restart cs2
echo "Готово. Нож выдаётся через 1,5 с после возрождения тем, у кого он надет на сайте."
