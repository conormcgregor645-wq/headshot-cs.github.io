#!/usr/bin/env bash
# Подключить свою модель игрока к плагину TASHER Style (модель уже должна быть в аддоне Мастерской, подключённом через voice-setup.sh).
# Запуск от root:  bash model-add.sh <ключ> "<название>" <путь .vmdl для CT> [путь .vmdl для T]
#   ключ — латиница/цифры/_, до 16 символов, такой же, как у предмета модели на сайте
#   пример: bash model-add.sh neo "Нео" characters/models/tasher/neo/neo.vmdl
# Убрать модель:  bash model-add.sh <ключ> --remove
set -euo pipefail
TS=/home/cs2/server/game/csgo/addons/counterstrikesharp/configs/plugins/TasherStyle/TasherStyle.json
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
KEY=${1:-}; NAME=${2:-}; CT=${3:-}; T=${4:-$CT}
[[ "$KEY" =~ ^[a-z0-9_]{1,16}$ ]] || { echo "ключ: латиница в нижнем регистре, цифры, _ (до 16 символов)"; exit 1; }
if [ "$NAME" != "--remove" ]; then
  [[ "$CT" == *.vmdl && "$T" == *.vmdl ]] || { echo "укажи путь к модели .vmdl, например characters/models/tasher/neo/neo.vmdl"; exit 1; }
fi
TS="$TS" KEY="$KEY" NAME="$NAME" CT="$CT" T="$T" python3 - <<'PY'
import json, os
p = os.environ["TS"]
try: j = json.load(open(p, encoding="utf-8"))
except Exception: j = {}
m = j.setdefault("Models", {})
k = os.environ["KEY"]
if os.environ["NAME"] == "--remove": m.pop(k, None); print("модель", k, "убрана")
else:
    m[k] = {"Name": os.environ["NAME"], "Ct": os.environ["CT"], "T": os.environ["T"]}
    print("модель", k, "→", m[k])
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
[ -n "${NORESTART:-}" ] && { echo "Записано (без перезапуска — перезапусти cs2 в конце: systemctl restart cs2)"; exit 0; }
systemctl restart cs2
echo "Готово. Сервер перезапущен — модель загрузится при следующем возрождении игрока, у которого она надета на сайте."
