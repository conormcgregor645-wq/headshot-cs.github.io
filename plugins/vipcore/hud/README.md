# Полноэкранное VIP-меню TASHER

Команда `!vip` показывает группе игрока карточки в трёх колонках. Нажатие ЛКМ переключает бонус или открывает настройки выбранного модуля. Кнопка «Закрыть» возвращает управление. Запасная консольная команда — `css_vip_close`. После 30 секунд без кликов меню закрывается.

## Проверка на стенде

1. Скачайте артефакт **tasher-vip-buy-menu** из сборки **vipcore** этой ветки. В нём находятся VIPCore.dll и пакет интерфейса tasher_buy.vpk. Для серверного расширения нужен CounterStrikeSharp с поддержкой OnCustomHudClicked и SetInputCaptureEnabled (проект собран с API 1.0.376).
2. На стенде смонтируйте пакет как игровой ресурс сервера и тестового клиента. Для локальной проверки можно извлечь VPK в отдельный тестовый аддон и запустить сервер и клиент с этим аддоном. Движок должен разрешать путь `panorama/layout/custom_game/tasher_buy.vxml_c`. Раздачу пакета обычным игрокам через Workshop нужно проверить отдельным подключением с чистого клиента.
3. Сохраните копию DLL и конфига на стенде. Установите DLL и задайте `"MenuType": "tasher_buy"` в `configs/plugins/VIPCore/vip_core.json`. После загрузки плагина откройте `!vip` двумя игроками с разными привилегиями. Проверьте курсор, независимость выбора, недоступную карточку, подменю и возврат в игру при закрытии и смерти.
4. Для возврата к проверенному клавиатурному меню задайте `"MenuType": "tasher"` и перечитайте конфигурацию VIPCore.

## Сборка ресурса

Исходники Panorama лежат в каталоге `panorama`. Пакет собран PanoramaCompiler (коммит `65f6ee675508552af17721341ca6ea630360ff76`) и VPKEdit CLI. Из этого каталога в пустой каталог сборки:

```bash
dotnet "$PANORAMA_COMPILER" compile-tree --input-root panorama --output-root "$BUILD_DIR/panorama"
cp addoninfo.txt "$BUILD_DIR/"
vpkeditcli --output tasher_buy.vpk --type vpk --version 2 --single-file "$BUILD_DIR"
vpkeditcli --verify-checksums files tasher_buy.vpk
```

[PanoramaCompiler](https://github.com/nicedayzhu/PanoramaCompiler) · [VPKEdit](https://github.com/craftablescience/VPKEdit)
