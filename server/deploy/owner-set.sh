#!/usr/bin/env bash
# Вписать владельца сайта (оператора персональных данных) — он появится в подвале, оферте, политике и согласии.
# Запуск от root:
#   ИП:          bash owner-set.sh ip   "Иванов Иван Иванович" <ИНН> <ОГРНИП> <почта>
#   самозанятый: bash owner-set.sh self "Иванов Иван Иванович" <ИНН> - <почта>
#   организация: bash owner-set.sh org  "ООО «Ташер»" <ИНН> <ОГРН> <почта>
set -euo pipefail
ENVF=/etc/tasher.env
[ "$(id -u)" = 0 ] || { echo "запусти от root"; exit 1; }
KIND=${1:-}; NAME=${2:-}; INN=${3:-}; OGRN=${4:-}; MAIL=${5:-}
[[ "$KIND" =~ ^(ip|self|org)$ ]] || { echo "первый параметр: ip, self или org"; exit 1; }
[ -n "$NAME" ] || { echo "укажи ФИО или название в кавычках"; exit 1; }
[[ "$INN" =~ ^[0-9]{10}([0-9]{2})?$ ]] || { echo "ИНН — 10 или 12 цифр"; exit 1; }
[ "$OGRN" = "-" ] && OGRN=""
[[ -z "$OGRN" || "$OGRN" =~ ^[0-9]{13}([0-9]{2})?$ ]] || { echo "ОГРН — 13 цифр, ОГРНИП — 15 цифр (для самозанятого поставь -)"; exit 1; }
[[ -z "$MAIL" || "$MAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "почта указана неверно"; exit 1; }
setenv() { local v=${2//|/}; if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$v|" "$ENVF"; else echo "$1=$v" >>"$ENVF"; fi; }
setenv OWNER_KIND "$KIND"; setenv OWNER_NAME "$NAME"; setenv OWNER_INN "$INN"; setenv OWNER_OGRN "$OGRN"; setenv OWNER_EMAIL "$MAIL"
systemctl restart tasher
echo "Готово: реквизиты на сайте обновлены."
