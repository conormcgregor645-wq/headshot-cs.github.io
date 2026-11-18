#!/usr/bin/env bash
# Проверка мгновенного применения скинов: сайт ставит игрока в очередь wp_player_refresh, плагин её забирает.
# Запуск от root, когда ты на игровом сервере:  bash check-skins.sh
set -uo pipefail
SID=$(grep '^OWNER_STEAMIDS=' /etc/tasher.env | cut -d= -f2 | cut -d, -f1)
CNF=/etc/tasher-wp.cnf
echo "SteamID: $SID"
echo "--- таблица очереди в базе плагина:"
mysql weaponpaints -e "SHOW CREATE TABLE wp_player_refresh\G" 2>&1 | grep -E "steamid|stamp|ERROR" | sed 's/^ *//'
echo "--- запрос от имени сайта (тот же SQL, что после «Надеть»):"
sudo -u tasher mysql --defaults-extra-file=$CNF weaponpaints <<SQL && echo "запись принята" || echo "ОШИБКА записи"
SET @q = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_player_refresh'), "INSERT INTO wp_player_refresh (steamid) VALUES ('$SID') ON DUPLICATE KEY UPDATE stamp = CURRENT_TIMESTAMP", 'DO 0');
PREPARE wp_refresh_q FROM @q; EXECUTE wp_refresh_q; DEALLOCATE PREPARE wp_refresh_q;
SQL
mysql -N weaponpaints -e "SELECT CONCAT('в очереди: ', steamid, ' ', stamp) FROM wp_player_refresh"
echo "--- жду, когда плагин заберёт запрос (до 20 с):"
for i in $(seq 1 20); do
  n=$(mysql -N weaponpaints -e "SELECT COUNT(*) FROM wp_player_refresh WHERE steamid='$SID'")
  if [ "$n" = "0" ]; then echo "плагин забрал запрос через ~${i} с — скины применяются сами"; break; fi
  sleep 1; printf '.'
done
[ "${n:-1}" = "0" ] || { echo; echo "запрос не забран за 20 с"; journalctl -u cs2 --since "-1min" --no-pager -o cat | grep -i "weaponpaints\|refresh" | tail -6; }
