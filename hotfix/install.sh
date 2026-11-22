#!/usr/bin/env bash
set -euo pipefail
dll=/home/cs2/server/game/csgo/addons/counterstrikesharp/plugins/VIPCore/VIPCore.dll
backup=/var/backups/tasher-vipcore/VIPCore-bee90dc.dll
unit=cs2.service
sha=65ababfb79543ca5f3d7fe1393c9370ecf1a3fcd0725a8d914793efe6e8681d5
[[ $EUID == 0 && -f "$dll" ]]
install -d -m 700 /var/backups/tasher-vipcore
exec 9>/var/backups/tasher-vipcore/install.lock
flock -n 9
stage=$(mktemp "$(dirname "$dll")/.vipcore.XXXXXXXX")
trap 'rm -f "$stage"' EXIT
old_version() { LC_ALL=C grep -aFq '2.0.3+bee90dcbb678e2f5e2b90ed119478074504991f9' "$1"; }
restore() {
    old_version "$backup"
    cp -p "$backup" "$stage"
    systemctl stop "$unit"
    mv -fT "$stage" "$dll"
    systemctl start "$unit"
    echo 'Прежняя DLL восстановлена.'
}
if [[ ${1:-} == rollback ]]; then restore; exit; fi
source_dll=$(dirname "$0")/VIPCore.dll
printf '%s  %s\n' "$sha" "$source_dll" | sha256sum -c -
if cmp -s "$source_dll" "$dll"; then echo 'Исправленная DLL уже установлена.'; exit; fi
old_version "$dll" || { echo 'Установлена другая версия. Установка остановлена.'; exit 1; }
if [[ -e "$backup" ]]; then cmp "$dll" "$backup"; else cp -p "$dll" "$backup"; fi
cp -p "$dll" "$stage"
cat "$source_dll" > "$stage"
cmp "$stage" "$source_dll"
systemctl stop "$unit"
if ! mv -fT "$stage" "$dll"; then systemctl start "$unit"; exit 1; fi
if systemctl start "$unit"; then
    invocation=$(systemctl show -p InvocationID --value "$unit")
    for ((i=0; i<60; i++)); do
        if [[ -n "$invocation" ]] && journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -o cat --no-pager | grep -Fi 'Finished loading plugin [VIP] Core' >/dev/null && systemctl is-active --quiet "$unit"; then
            echo 'VIPCore cc2ca1e загружен. Можно проверять !vip.'
            exit 0
        fi
        sleep 2
    done
fi
echo 'Загрузка VIPCore не подтверждена. Возвращаю резервную копию.'
restore
exit 1
