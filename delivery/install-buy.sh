#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/var/backups/tasher-vip-buy
game=/home/cs2/server/game/csgo
unit=cs2.service
id=3844493324
dll=addons/counterstrikesharp/plugins/VIPCore/VIPCore.dll
json=addons/counterstrikesharp/configs/plugins/VIPCore/vip_core.json
cfg=cfg/multiaddonmanager/multiaddonmanager.cfg
vdf=addons/metamod/multiaddonmanager.vdf
so=addons/multiaddonmanager/bin/multiaddonmanager.so
files=("$dll" "$json" "$so" "$cfg" "$vdf")
die() { echo "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Запусти от root.'
cd "$game"
exec 9>"$root/install.lock"
flock -n 9 || die 'Установка уже выполняется.'
restore() {
    local f
    systemctl stop "$unit" || return 1
    for f in "${files[@]}"; do
        if [[ -f "$backup/original/$f" ]]; then
            cp -a --remove-destination "$backup/original/$f" "$f" || return 1
        else
            rm -f -- "$f" || return 1
        fi
    done
    systemctl start "$unit" && systemctl is-active --quiet "$unit" || return 1
    rm -f "$root/current"
    echo 'Прежние файлы восстановлены. cs2.service активен.'
}
if [[ ${1:-} == rollback ]]; then
    [[ -L "$root/current" ]] || die 'Нет активной установки для отката.'
    backup=$(readlink -f "$root/current")
    restore
    exit
fi
[[ ! -e "$root/current" ]] || die 'Установка уже начата или завершена. Для восстановления используй rollback.'
systemctl is-active --quiet "$unit" || die 'Сервис не активен до установки.'
(cd "$root/staging"; sha256sum -c <<'SUMS'
5992e415602b9be8f3c0f5176044bdaf39c9266ece5265c2f1c03691fad0d748  MultiAddonManager.tar.gz
938c884babd9974298567f74d52b71628ad70707f012278a3e4a6a38ac5b5aed  VIPCore.dll
SUMS
)
backup=$(mktemp -d "$root/change-XXXXXXXX")
mkdir "$backup/new" "$backup/original"
tar -xzf "$root/staging/MultiAddonManager.tar.gz" -C "$backup/new" --no-same-owner
[[ -f "$dll" && -f "$json" ]] || die 'Не найдена DLL или конфигурация VIPCore.'
for f in "${files[@]}"; do
    [[ ! -L "$f" ]] || die "Обнаружена символическая ссылка $f"
    if [[ -e "$f" ]]; then cp -a --parents "$f" "$backup/original/"; fi
done
# Keep existing manager settings and append the new addon to its list.
if [[ -f "$cfg" ]]; then cp "$cfg" "$backup/new/$cfg"; fi
python3 - "$backup/new/$cfg" "$id" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
pattern = r'(?m)^([ \t]*mm_extra_addons[ \t]+)"([\d, \t]*)"'
matches = list(re.finditer(pattern, text))
if len(matches) != 1:
    sys.exit('Не удалось однозначно прочитать mm_extra_addons. Сервис продолжает работать.')
m = matches[0]
ids = [x.strip() for x in m[2].split(',') if x.strip()]
if sys.argv[2] not in ids:
    ids.append(sys.argv[2])
p.write_text(text[:m.start(2)] + ','.join(ids) + text[m.end(2):])
PY
jq -e 'if type == "object" then .MenuType = "tasher_buy" else error("invalid config") end' "$json" > "$backup/new/vip.json"
ln -s "$backup" "$root/current"
recover() {
    rc=$?
    trap - EXIT HUP INT TERM
    if (( rc )); then
        echo "Установка прервана. Восстанавливаю из $backup."
        restore || echo "Автооткат не завершился. Запусти этот скрипт с rollback." >&2
    fi
    exit "$rc"
}
trap recover EXIT
trap 'exit 130' HUP INT TERM
systemctl stop "$unit"
for f in "$so" "$cfg" "$vdf"; do
    install -D -m 644 "$backup/new/$f" "$f"
done
# Preserve user/group and mode of site-owned files.
cat "$root/staging/VIPCore.dll" > "$dll"
cat "$backup/new/vip.json" > "$json"
systemctl start "$unit"
inv=$(systemctl show -p InvocationID --value "$unit")
[[ -n "$inv" ]] || die 'Не удалось получить идентификатор запуска.'
echo 'Ожидаю загрузку VIPCore и подключение Workshop-пакета (до пяти минут).'
for ((i=0; i<100; i++)); do
    if journalctl "_SYSTEMD_INVOCATION_ID=$inv" -o cat --no-pager | awk '
      index($0,"Finished loading plugin [VIP] Core") {vip=1}
      /Adding search path:.*3844493324/ {hud=1}
      END {exit !(vip && hud)}' &&
      [[ $(systemctl show -p InvocationID --value "$unit") == "$inv" ]] && systemctl is-active --quiet "$unit"; then
        echo 'Готово: VIPCore загружен, Workshop 3844493324 подключён. Перезайди и проверь !vip.'
        exit 0
    fi
    sleep 3
done
die 'Загрузка VIPCore и Workshop-пакета не подтвердилась.'
