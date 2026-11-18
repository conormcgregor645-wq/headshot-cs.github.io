#!/usr/bin/env bash
# VIP-плагин для CS2 (VIPCore + модули): статусы VIP…KING с сайта дают бонусы в игре.
# Запуск от root:  bash /opt/tasher/server/deploy/vip-setup.sh
# Статусы выдаёт только сайт (магазин, админка, итоги месяца) — он сам пишет их в базу плагина.
# Делает копию; если плагин не загрузится — сам всё возвращает как было.
set -euo pipefail
CSGO=/home/cs2/server/game/csgo; CSS=$CSGO/addons/counterstrikesharp
PLG=$CSS/plugins; CFGD=$CSS/configs/plugins/VIPCore; SHARED=$CSS/shared/VipCoreApi
REPO="${VIP_REPO:-partiusfabaa/cs2-VIPCore}"
MODS="VIP_Health VIP_Armor VIP_Money VIP_Grenades VIP_DefuseKit VIP_Healthshot VIP_Zeus VIP_WeaponsMenu VIP_RegenHealth VIP_Vampirism VIP_SmokeColor VIP_Tag"
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
CORE_URL=$(jq -r '[.[] | select(.draft|not) | .assets[] | select(.name=="VIPCore.zip") | .browser_download_url][0] // empty' "$TMP/rel.json")
MODS_URL=$(jq -r '[.[] | select(.draft|not) | .assets[] | select(.name=="VIP_Modules.zip") | .browser_download_url][0] // empty' "$TMP/rel.json")
[ -n "$CORE_URL" ] && [ -n "$MODS_URL" ] || die "не нашёл файлы релиза"
echo "ядро:   $(basename "$(dirname "$CORE_URL")")"; echo "модули: $(basename "$(dirname "$MODS_URL")")"
curl -fsSL -o "$TMP/core.zip" "$CORE_URL"; curl -fsSL -o "$TMP/mods.zip" "$MODS_URL"
mkdir "$TMP/c" "$TMP/m"; unzip -q -o "$TMP/core.zip" -d "$TMP/c"; unzip -q -o "$TMP/mods.zip" -d "$TMP/m"
CA=$(find "$TMP/c" -maxdepth 3 -type d -name counterstrikesharp | head -1)
[ -n "$CA" ] && [ -f "$CA/plugins/VIPCore/VIPCore.dll" ] && [ -f "$CA/shared/VipCoreApi/VipCoreApi.dll" ] || die "в архиве ядра нет VIPCore.dll или VipCoreApi.dll"
for m in $MODS; do d=$(find "$TMP/m" -maxdepth 3 -type d -name "$m" | head -1); [ -n "$d" ] && [ -f "$d/$m.dll" ] || die "в архиве модулей нет $m"; done
echo "архивы в порядке"

log "2/6 Копия текущего состояния"
mkdir -p "$BK/plugins" "$BK/shared" "$BK/config"
for d in "$PLG"/VIPCore "$PLG"/VIP_*; do [ -e "$d" ] && cp -a "$d" "$BK/plugins/" || true; done
[ -e "$SHARED" ] && cp -a "$SHARED" "$BK/shared/" || true
[ -e "$CFGD" ] && cp -a "$CFGD/." "$BK/config/" || true
cp -a "$CSS/configs/core.json" "$BK/core.json" 2>/dev/null || true
echo "копия в $BK"
restore() {
  echo "Возвращаю как было…"; systemctl stop cs2 || true
  rm -rf "$PLG"/VIPCore "$PLG"/VIP_* "$SHARED"
  cp -a "$BK/plugins/." "$PLG/" 2>/dev/null || true
  cp -a "$BK/shared/." "$CSS/shared/" 2>/dev/null || true
  [ -f "$BK/core.json" ] && cp -a "$BK/core.json" "$CSS/configs/core.json" || true
  chown -R cs2:cs2 /home/cs2; systemctl start cs2; echo "плагины возвращены (настройки VIP оставлены в $CFGD)"
}

log "3/6 Установка"
systemctl stop cs2
rm -rf "$PLG"/VIPCore "$PLG"/VIP_* "$SHARED"
mkdir -p "$PLG" "$CSS/shared" "$CFGD/Modules"
cp -r "$CA/plugins/VIPCore" "$PLG/"
cp -r "$CA/shared/VipCoreApi" "$CSS/shared/"
for m in $MODS; do d=$(find "$TMP/m" -maxdepth 3 -type d -name "$m" | head -1); cp -r "$d" "$PLG/"; done
echo "установлено: ядро и модули: $MODS"

log "4/6 Настройки статусов (VIP, PREMIUM, ELITE, LEGEND, TITAN, KING)"
IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || echo 0.0.0.0)
DB_PASS="$DB_PASS" IP="$IP" CFGD="$CFGD" CORE="$CSS/configs/core.json" PYTHONPATH=/home/cs2 python3 - <<'PY'
import json, os
d = os.environ["CFGD"]
core = {
  "Delay": 2.0, "TimeMode": 3, "ServerId": 0, "ServerIP": os.environ["IP"], "ServerPort": 27015,
  "MenuType": "center", "ReOpenMenuAfterItemClick": False, "AdminMenuPermission": ["@css/root"],
  # в пистолетных раундах у всех равные условия
  "DisableOnPistolRound": ["Items", "Grenades", "Health", "Armor", "Healthshot", "Zeus", "DefuseKit", "WeaponsMenu", "HealthRegen", "Vampirism"],
  "VipLogging": True,
  "Connection": {"Host": "127.0.0.1", "Database": "weaponpaints", "User": "wp", "Password": os.environ["DB_PASS"], "Port": 3306},
}
def nades(fl=1, smoke=0, he=0, fire=0):
    ct = {"weapon_flashbang": fl}; t = {"weapon_flashbang": fl}
    if smoke: ct["weapon_smokegrenade"] = t["weapon_smokegrenade"] = 1
    if he: ct["weapon_hegrenade"] = t["weapon_hegrenade"] = 1
    if fire: ct["weapon_incgrenade"] = 1; t["weapon_molotov"] = 1
    return {"CT": ct, "T": t}
guns = {
  "CT": {"M4A1-S + Desert Eagle": {"Weapons": ["weapon_m4a1_silencer", "weapon_deagle"], "Round": 3},
         "M4A4 + Desert Eagle": {"Weapons": ["weapon_m4a1", "weapon_deagle"], "Round": 3},
         "AWP + Desert Eagle": {"Weapons": ["weapon_awp", "weapon_deagle"], "Round": 3}},
  "T": {"AK-47 + Desert Eagle": {"Weapons": ["weapon_ak47", "weapon_deagle"], "Round": 3},
        "AWP + Desert Eagle": {"Weapons": ["weapon_awp", "weapon_deagle"], "Round": 3}},
}
tag = lambda n, c: {"ScoreboardTag": n, "ChatTag": f"[{n}]", "ColorTag": c, "NameColor": c, "MessageColor": "default"}
groups = {
  "VIP":     {"Health": 105, "Armor": 100, "Money": "++300",  "Grenades": nades(1), "Tag": tag("VIP", "silver")},
  "PREMIUM": {"Health": 110, "Armor": 100, "Money": "++500",  "Grenades": nades(1, 1), "DefuseKit": True, "Tag": tag("PREMIUM", "lightblue")},
  "ELITE":   {"Health": 115, "Armor": 100, "Money": "++800",  "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 1, "Tag": tag("ELITE", "green")},
  "LEGEND":  {"Health": 120, "Armor": 100, "Money": "++1000", "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 1, "Zeus": True, "WeaponsMenu": guns, "Tag": tag("LEGEND", "purple")},
  "TITAN":   {"Health": 125, "Armor": 100, "Money": "++1500", "Grenades": nades(1, 1, 1, 1), "DefuseKit": True, "Healthshot": 2, "Zeus": True, "WeaponsMenu": guns,
              "HealthRegen": {"Health": 5, "Delay": 5, "Interval": 2}, "Vampirism": 10, "Tag": tag("TITAN", "orange")},
  "KING":    {"Health": 130, "Armor": 100, "Money": "++2000", "Grenades": nades(2, 1, 1, 1), "DefuseKit": True, "Healthshot": 2, "Zeus": True, "WeaponsMenu": guns,
              "HealthRegen": {"Health": 5, "Delay": 5, "Interval": 2}, "Vampirism": 15, "SmokeColor": [-1, -1, -1], "Tag": tag("KING", "gold")},
}
json.dump(core, open(os.path.join(d, "vip_core.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
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
  if printf '%s' "$J" | grep -q "Failed to load plugin.*\(VIP\|Vip\)"; then break; fi
  C=$(printf '%s' "$J" | grep -c "Finished loading plugin \[VIP\]" || true)
  if [ "$C" -ge $((N + 1)) ]; then OKC=1; break; fi
  sleep 5; printf '.'
done; echo
J=$(journalctl -u cs2 --since "$SINCE" --no-pager -o cat)
printf '%s\n' "$J" | grep -E "Finished loading plugin \[VIP\]" | sed 's/.*Finished loading plugin /  загружен: /' | sort -u
if [ -z "$OKC" ]; then
  printf '%s\n' "$J" | grep -iE "vip|exception|error" | grep -v "Finished loading" | tail -20 | cut -c1-240
  restore; die "VIP-плагин загрузился не полностью — вернул как было. Пришли вывод выше"
fi
T=""
for i in $(seq 1 12); do
  [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='weaponpaints' AND TABLE_NAME='vip_users'")" = 1 ] && { T=1; break; }; sleep 5
done
if [ -z "$T" ]; then
  printf '%s\n' "$J" | grep -iE "database|mysql|vip" | tail -10 | cut -c1-240
  restore; die "плагин не создал таблицу vip_users (нет связи с базой) — вернул как было. Пришли вывод выше"
fi
echo "таблица статусов создана"

log "6/6 Статусы с сайта -> в игру"
systemctl restart tasher; sleep 6
SITE=$(curl -fsS http://127.0.0.1:8080/api/statuses | jq '.statuses | length' 2>/dev/null || echo "?")
DBN=$(mysql -N -e "SELECT COUNT(*) FROM weaponpaints.vip_users WHERE sid=0")
echo "статусов на сайте: $SITE, в базе плагина: $DBN"
[ "$SITE" = "$DBN" ] || echo "  (числа сравняются в течение минуты — сайт сверяет их раз в минуту)"
mysql -N -e "SELECT account_id, \`group\`, FROM_UNIXTIME(expires) FROM weaponpaints.vip_users WHERE sid=0 ORDER BY expires DESC LIMIT 10" | sed 's/^/  /'
printf '\n\033[1;32m=== ГОТОВО ===\033[0m\nКопия прежнего состояния: %s\nВ игре: !vip — меню привилегии. Статусы выдаются с сайта (магазин, админка, итоги месяца) и действуют сразу.\n' "$BK"
