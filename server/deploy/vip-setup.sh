#!/usr/bin/env bash
# VIP-плагин для CS2 (VIPCore + модули): статусы VIP…KING с сайта дают бонусы в игре.
# И плагин TASHER Style: тег и цвет ника в чате, тег в таблице счёта, цвет дыма, эффекты, команды, особые раунды и серии — по данным сайта.
# Запуск от root:  bash /opt/tasher/server/deploy/vip-setup.sh
# Статусы выдаёт только сайт (магазин, админка, итоги месяца) — он сам пишет их в базу плагина.
# Делает копию; если плагин не загрузится — сам всё возвращает как было.
set -euo pipefail
CSGO=/home/cs2/server/game/csgo; CSS=$CSGO/addons/counterstrikesharp
PLG=$CSS/plugins; CFGD=$CSS/configs/plugins/VIPCore; SHARED=$CSS/shared/VipCoreApi
REPO="${VIP_REPO:-partiusfabaa/cs2-VIPCore}"
# ядро и модуль цветного дыма с правками TASHER (меню на WASD, исправленный дым) — собираются на GitHub из plugins/vipcore
TASHER_ZIP="${VIP_TASHER_ZIP:-https://github.com/conormcgregor645-wq/headshot-cs.github.io/releases/download/vipcore-tasher/VIPCore-tasher.zip}"
MODS="VIP_Health VIP_Armor VIP_Money VIP_Grenades VIP_DefuseKit VIP_Healthshot VIP_Zeus VIP_RegenHealth VIP_Vampirism"
# теги в чате и цвет дыма теперь делает TASHER Style (с учётом клана и купленного на сайте), модули VIP_Tag и VIP_SmokeColor не ставим
STYLE_ZIP="${TASHER_STYLE_ZIP:-https://github.com/conormcgregor645-wq/headshot-cs.github.io/releases/download/tasherstyle/TasherStyle.zip}"
# общая библиотека меню CS2MenuManager (форк mrc4tt) — без неё WeaponPaints не регистрирует свои команды (в том числе
# css_wp_refresh, которой сайт мгновенно применяет скины). Берём последний релиз, если GitHub не ответил — проверенную 1.0.45
MM_REPO="${MM_REPO:-mrc4tt/CS2MenuManager}"
MM_FALLBACK="https://github.com/mrc4tt/CS2MenuManager/releases/download/1.0.45/CS2MenuManager-1.0.45.zip"
BK=/root/vip-backup-$(date +%Y%m%d-%H%M%S)
log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "запусти от root"
[ -d "$CSS" ] || die "CounterStrikeSharp не установлен"
. /etc/tasher/cs2.env
[ -n "${DB_PASS:-}" ] || die "в /etc/tasher/cs2.env нет DB_PASS"
command -v jq >/dev/null || apt-get install -y jq >/dev/null

log "1/6 Скачиваю VIPCore ($REPO)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" -o "$TMP/rel.json" || die "GitHub не ответил"
# полный набор модулей лежит в релизе ядра; релизы «vX.Y.Z-modules-N» содержат только изменённые модули — накладываем их по порядку
# Версия закреплена: сборка TASHER (plugins/vipcore) сделана на VIPCore 2.0.3, а модули и библиотека VipCoreApi
# должны быть той же версии — с 2.0.4 у ядра новые функции, и модули 2.0.4 с нашим ядром не загружаются.
# Переход на новую версию — только вместе с обновлением plugins/vipcore. Свою версию можно задать: VIP_CORE_TAG=v2.0.4
CORE_TAG="${VIP_CORE_TAG:-v2.0.3}"
jq -e --arg t "$CORE_TAG" 'any(.[]; .tag_name==$t and any(.assets[]; .name=="VIPCore.zip"))' "$TMP/rel.json" >/dev/null \
  || die "не нашёл релиз VIPCore $CORE_TAG с VIPCore.zip"
url_of() { jq -r --arg t "$1" --arg n "$2" '.[] | select(.tag_name==$t) | .assets[] | select(.name==$n) | .browser_download_url' "$TMP/rel.json" | head -1; }
CORE_URL=$(url_of "$CORE_TAG" VIPCore.zip); BASE_MODS=$(url_of "$CORE_TAG" VIP_Modules.zip)
[ -n "$CORE_URL" ] && [ -n "$BASE_MODS" ] || die "в релизе $CORE_TAG нет VIPCore.zip или VIP_Modules.zip"
echo "ядро и модули: $CORE_TAG"
curl -fsSL -o "$TMP/core.zip" "$CORE_URL"; curl -fsSL -o "$TMP/mods.zip" "$BASE_MODS"
mkdir "$TMP/c" "$TMP/m"; unzip -q -o "$TMP/core.zip" -d "$TMP/c"; unzip -q -o "$TMP/mods.zip" -d "$TMP/m"
for T in $(jq -r --arg t "$CORE_TAG" '.[] | select(.draft|not) | .tag_name | select(startswith($t + "-modules-"))' "$TMP/rel.json" | sort -t- -k3 -n); do
  U=$(url_of "$T" VIP_Modules.zip); [ -n "$U" ] || continue
  rm -rf "$TMP/u"; mkdir "$TMP/u"; curl -fsSL -o "$TMP/u.zip" "$U"; unzip -q -o "$TMP/u.zip" -d "$TMP/u"
  for d in "$TMP"/u/*/; do n=$(basename "$d"); [ -f "$d/$n.dll" ] || continue; rm -rf "$TMP/m/$n"; cp -r "$d" "$TMP/m/$n"; echo "обновление модуля $n из $T"; done
done
CA=$(find "$TMP/c" -maxdepth 3 -type d -name counterstrikesharp | head -1)
[ -n "$CA" ] && [ -f "$CA/plugins/VIPCore/VIPCore.dll" ] && [ -f "$CA/shared/VipCoreApi/VipCoreApi.dll" ] || die "в архиве ядра нет VIPCore.dll или VipCoreApi.dll"
for m in $MODS; do
  if [ ! -f "$TMP/m/$m/$m.dll" ]; then echo "модули в архиве:"; ls "$TMP/m" | sed 's/^/  /'; die "в архиве модулей нет $m"; fi
done
curl -fsSL -o "$TMP/tasher.zip" "$TASHER_ZIP" || die "не скачал сборку TASHER ($TASHER_ZIP)"
mkdir "$TMP/t"; unzip -q -o "$TMP/tasher.zip" -d "$TMP/t"
TA="$TMP/t/addons/counterstrikesharp"
[ -f "$TA/plugins/VIPCore/VIPCore.dll" ] && [ -f "$TA/plugins/VIPCore/CS2MenuManager.dll" ] && [ -f "$TA/shared/CS2MenuManager/config.toml" ] || die "в сборке TASHER не хватает файлов"
curl -fsSL -o "$TMP/style.zip" "$STYLE_ZIP" || die "не скачал TASHER Style ($STYLE_ZIP)"
mkdir "$TMP/s"; unzip -q -o "$TMP/style.zip" -d "$TMP/s"
MM_URL=$(curl -fsSL "https://api.github.com/repos/$MM_REPO/releases/latest" 2>/dev/null | jq -r '[.assets[] | select(.name | test("^CS2MenuManager-.*\\.zip$")) | .browser_download_url][0] // empty' 2>/dev/null || true)
[ -n "$MM_URL" ] || MM_URL="$MM_FALLBACK"
curl -fsSL -o "$TMP/mm.zip" "$MM_URL" || curl -fsSL -o "$TMP/mm.zip" "$MM_FALLBACK" || die "не скачал CS2MenuManager"
mkdir "$TMP/mm"; unzip -q -o "$TMP/mm.zip" -d "$TMP/mm"
MMA=$(find "$TMP/mm" -maxdepth 4 -type d -path '*counterstrikesharp/shared/CS2MenuManager' | head -1)
[ -n "$MMA" ] && [ -f "$MMA/CS2MenuManager.dll" ] || die "в архиве CS2MenuManager нет CS2MenuManager.dll"
echo "библиотека меню: $(basename "$MM_URL" .zip)"
SA="$TMP/s/addons/counterstrikesharp/plugins/TasherStyle"
[ -f "$SA/TasherStyle.dll" ] && [ -f "$SA/MySqlConnector.dll" ] || die "в архиве TASHER Style не хватает файлов"
echo "архивы в порядке"

log "2/6 Копия текущего состояния"
mkdir -p "$BK/plugins" "$BK/shared" "$BK/config"
for d in "$PLG"/VIPCore "$PLG"/VIP_* "$PLG"/TasherStyle; do [ -e "$d" ] && cp -a "$d" "$BK/plugins/" || true; done
[ -e "$SHARED" ] && cp -a "$SHARED" "$BK/shared/" || true
[ -e "$CSS/shared/CS2MenuManager" ] && cp -a "$CSS/shared/CS2MenuManager" "$BK/shared/" || true
[ -e "$CFGD" ] && cp -a "$CFGD/." "$BK/config/" || true
cp -a "$CSS/configs/core.json" "$BK/core.json" 2>/dev/null || true
echo "копия в $BK"
restore() {
  echo "Возвращаю как было…"; systemctl stop cs2 || true
  rm -rf "$PLG"/VIPCore "$PLG"/VIP_* "$PLG"/TasherStyle "$SHARED" "$CSS/shared/CS2MenuManager"
  cp -a "$BK/plugins/." "$PLG/" 2>/dev/null || true
  cp -a "$BK/shared/." "$CSS/shared/" 2>/dev/null || true
  [ -f "$BK/core.json" ] && cp -a "$BK/core.json" "$CSS/configs/core.json" || true
  chown -R cs2:cs2 /home/cs2; systemctl start cs2; echo "плагины возвращены (настройки VIP оставлены в $CFGD)"
}

log "3/6 Установка"
systemctl stop cs2
rm -rf "$PLG"/VIPCore "$PLG"/VIP_* "$PLG"/TasherStyle "$SHARED" "$CSS/shared/CS2MenuManager"
mkdir -p "$PLG" "$CSS/shared" "$CFGD/Modules"
cp -r "$CA/plugins/VIPCore" "$PLG/"
cp -r "$CA/shared/VipCoreApi" "$CSS/shared/"
for m in $MODS; do cp -r "$TMP/m/$m" "$PLG/"; done
# правки TASHER поверх: ядро с меню на WASD, исправленный цветной дым, настройки меню
rm -rf "$PLG/VIPCore"
cp -r "$TA/plugins/VIPCore" "$PLG/"
cp -r "$SA" "$PLG/TasherStyle"
# библиотека меню целиком (нужна WeaponPaints и VIP), поверх — наши настройки меню (WASD, игрок стоит на месте)
cp -r "$MMA" "$CSS/shared/CS2MenuManager"
cp "$TA/shared/CS2MenuManager/config.toml" "$CSS/shared/CS2MenuManager/config.toml"
echo "установлено: ядро и модули: $MODS, библиотека меню"

log "4/6 Настройки статусов (VIP, PREMIUM, ELITE, LEGEND, TITAN, KING)"
IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || echo 0.0.0.0)
DB_PASS="$DB_PASS" IP="$IP" CFGD="$CFGD" CORE="$CSS/configs/core.json" PYTHONPATH=/home/cs2 python3 - <<'PY'
import json, os
d = os.environ["CFGD"]
core = {
  "Delay": 2.0, "TimeMode": 3, "ServerId": 0, "ServerIP": os.environ["IP"], "ServerPort": 27015,
  "MenuType": "tasher", "ReOpenMenuAfterItemClick": True, "AdminMenuPermission": ["@css/root"],
  # все бонусы работают с 1-го раунда; деньги в пистолетных раундах не даёт сам модуль денег
  "DisableOnPistolRound": [],
  "VipLogging": True,
  "Connection": {"Host": "127.0.0.1", "Database": "weaponpaints", "User": "wp", "Password": os.environ["DB_PASS"], "Port": 3306},
}
def nades(fl=1, smoke=0, he=0, fire=0):
    ct = {"weapon_flashbang": fl}; t = {"weapon_flashbang": fl}
    if smoke: ct["weapon_smokegrenade"] = t["weapon_smokegrenade"] = 1
    if he: ct["weapon_hegrenade"] = t["weapon_hegrenade"] = 1
    if fire: ct["weapon_incgrenade"] = 1; t["weapon_molotov"] = 1
    return {"CT": ct, "T": t}
groups = {
  "VIP":     {"Health": 105, "Armor": 100, "Money": "++300",  "Grenades": nades(1)},
  "PREMIUM": {"Health": 110, "Armor": 100, "Money": "++500",  "Grenades": nades(1, 1), "DefuseKit": True},
  "ELITE":   {"Health": 115, "Armor": 100, "Money": "++800",  "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 1},
  "LEGEND":  {"Health": 120, "Armor": 100, "Money": "++1000", "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 1, "Zeus": True},
  "TITAN":   {"Health": 125, "Armor": 100, "Money": "++1500", "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 2, "Zeus": True,
              "HealthRegen": {"Health": 5, "Delay": 5, "Interval": 2}, "Vampirism": 10},
  "KING":    {"Health": 130, "Armor": 100, "Money": "++2000", "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 2, "Zeus": True,
              "HealthRegen": {"Health": 5, "Delay": 5, "Interval": 2}, "Vampirism": 15},
}
json.dump(core, open(os.path.join(d, "vip_core.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
sd = os.path.join(os.path.dirname(d), "TasherStyle"); os.makedirs(sd, exist_ok=True)
json.dump({"Host": "127.0.0.1", "Port": 3306, "User": "wp", "Password": os.environ["DB_PASS"], "Database": "weaponpaints", "ReloadSeconds": 20, "PremierScoreboardEnabled": True, "ConfigVersion": 1},
          open(os.path.join(sd, "TasherStyle.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(groups, open(os.path.join(d, "vip.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# сообщения плагинов на русском
p = os.environ["CORE"]
if os.path.exists(p):
    from cssjson import load
    j = load(p); j["ServerLanguage"] = "ru"
    json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("настройки записаны")
PY
chown -R cs2:cs2 /home/cs2; chmod 640 "$CFGD/vip_core.json"

log "5/6 Запуск и проверка"
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start cs2
N=$(echo $MODS | wc -w); OKC=""
for i in $(seq 1 36); do
  J=$(journalctl -u cs2 --since "$SINCE" --no-pager -o cat)
  if printf '%s' "$J" | grep -q "Failed to load plugin.*\(VIP\|Vip\|TASHER\|Tasher\)"; then break; fi
  C=$(printf '%s' "$J" | grep -c "Finished loading plugin \[VIP\]" || true)
  if [ "$C" -ge $((N + 1)) ] && printf '%s' "$J" | grep -q "Finished loading plugin TASHER Style"; then OKC=1; break; fi
  sleep 5; printf '.'
done; echo
J=$(journalctl -u cs2 --since "$SINCE" --no-pager -o cat)
printf '%s\n' "$J" | grep -E "Finished loading plugin (\[VIP\]|TASHER Style)" | sed 's/.*Finished loading plugin /  загружен: /' | sort -u
if [ -z "$OKC" ]; then
  printf '%s\n' "$J" | grep -iE "vip|tasher|exception|error" | grep -v "Finished loading" | tail -20 | cut -c1-240
  restore; die "плагины загрузились не полностью — вернул как было. Пришли вывод выше"
fi
if printf '%s\n' "$J" | grep -q "запрет закупки недоступен"; then
  echo "  внимание: особые раунды работают без запрета закупки (лишнее оружие отбирается после закупки) — обнови CounterStrikeSharp"
fi
# скины: WeaponPaints должен загрузиться целиком (с библиотекой меню), иначе сайт не применяет скины сразу
sleep 3; J=$(journalctl -u cs2 --since "$SINCE" --no-pager -o cat)
if printf '%s' "$J" | grep -q "Error while loading required plugins"; then
  printf '%s\n' "$J" | grep -iE "weaponpaints|menumanager" | tail -10 | cut -c1-240
  printf '\n\033[1;33mВНИМАНИЕ: WeaponPaints не нашёл библиотеку меню — скины с сайта применятся только после перезахода. Пришли вывод выше\033[0m\n'
else echo "WeaponPaints: загружен полностью, скины с сайта применяются сразу"; fi
T=""
for i in $(seq 1 12); do
  [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME='vip_users'")" = 1 ] && { T=1; break; }; sleep 5
done
if [ -z "$T" ]; then
  printf '%s\n' "$J" | grep -iE "database|mysql|vip" | tail -10 | cut -c1-240
  restore; die "плагин не создал таблицу vip_users (нет связи с базой) — вернул как было. Пришли вывод выше"
fi
echo "таблица статусов создана"
T=""
for i in $(seq 1 12); do
  # таблица и все 4 колонки эффектов (их добавляет TASHER Style 1.1)
  # и таблицы для команд !rank/!top/!tk/!quests (TASHER Style 1.2)
  [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME='tasher_style' AND COLUMN_NAME IN ('kill_fx','kill_snd','trail','tracer')")" = 4 ] && \
  [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME IN ('tasher_player','tasher_top','tasher_punish')")" = 3 ] && \
  [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME='tasher_player' AND COLUMN_NAME IN ('league','sr','league_info','pass')")" = 4 ] && { T=1; break; }; sleep 5
done
if [ -z "$T" ]; then
  printf '%s\n' "$J" | grep -iE "tasher|mysql" | tail -10 | cut -c1-240
  restore; die "TASHER Style не подготовил таблицу tasher_style (нет связи с базой) — вернул как было. Пришли вывод выше"
fi
echo "таблицы стилей, эффектов и команд в игре готовы"

log "6/6 Статусы с сайта -> в игру"
# стартовый бонус новым игрокам — 3000 ТК (один раз заменяем прежний 0; потом можно менять в /etc/tasher.env)
if [ -f /etc/tasher.env ] && [ ! -f /etc/tasher/.start_tk_3000 ]; then
  if grep -q '^START_TK=' /etc/tasher.env; then sed -i 's|^START_TK=.*|START_TK=3000|' /etc/tasher.env; else echo "START_TK=3000" >>/etc/tasher.env; fi
  mkdir -p /etc/tasher; touch /etc/tasher/.start_tk_3000; echo "стартовый бонус новым игрокам: 3000 ТК"
fi
# свежая версия команды tasher-update
[ -f /opt/tasher/server/deploy/update.sh ] && install -m 755 /opt/tasher/server/deploy/update.sh /usr/local/bin/tasher-update
[ -f /opt/tasher/server/deploy/self-check.sh ] && install -m 755 /opt/tasher/server/deploy/self-check.sh /usr/local/bin/tasher-check
systemctl restart tasher; sleep 6
SITE=$(curl -fsS http://127.0.0.1:8080/api/statuses | jq '.statuses | length' 2>/dev/null || echo "?")
DBN=$(mysql -N -e "SELECT COUNT(*) FROM weaponpaints.vip_users WHERE sid=0")
echo "статусов на сайте: $SITE, в базе плагина: $DBN"
[ "$SITE" = "$DBN" ] || echo "  (числа сравняются в течение минуты — сайт сверяет их раз в минуту)"
mysql -N -e "SELECT account_id, \`group\`, FROM_UNIXTIME(expires) FROM weaponpaints.vip_users WHERE sid=0 ORDER BY expires DESC LIMIT 10" | sed 's/^/  /'
sleep 5; echo "стилей в игре (теги, цвета, дым, эффекты): $(mysql -N -e "SELECT COUNT(*) FROM weaponpaints.tasher_style")"
echo "игроков для !rank/!tk/!quests: $(mysql -N -e "SELECT COUNT(*) FROM weaponpaints.tasher_player") (сайт обновляет раз в 30 секунд)"
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\nКопия прежнего состояния: %s\nВ игре: !vip — меню привилегии. Статусы выдаются с сайта (магазин, админка, итоги месяца) и действуют сразу.\nКоманды в чате игры: !rank !top !tk !quests !pass\nОсобые раунды — сами раз в 2–3 раунда; назначить вручную: админка сайта → Сервер → «Особый раунд»\nПроверить всё одной командой: tasher-check\n' "$BK"
