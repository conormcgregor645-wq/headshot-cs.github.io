# TASHER: свои модели оружия для аддона Мастерской.
#
# Что делает (всё на твоём компьютере, сервер не трогает):
#   1. Переносит модели оружия из распакованных архивов в аддон так, чтобы Workshop Manager их упаковал
#      (через CS2-AG2-Port: разбирает .vmdl_c в исходники и собирает заново внутри аддона).
#   2. Достаёт из игры свежий scripts/weapons.vdata и добавляет в конец записи weapon_tasher_<ключ>.
#      Каждая запись — копия того оружия, под чей скелет сделана модель (кукри → нож "526", Desert Eagle → "1"…),
#      с заменой только имени и пути к модели. Скелет берётся из самой модели — ошибиться нельзя.
#   3. Компилирует weapons.vdata в аддоне и печатает готовые команды для сервера (weapon-model-add.sh).
#
# Запуск (PowerShell, из папки со скриптом):
#   powershell -ExecutionPolicy Bypass -File .\Build-Weapons.ps1 -Source "C:\Users\<ты>\Desktop\weapons" -Addon <аддон>
#     -Source  — папка, где лежат распакованные архивы (внутри каждого — папка weapons\...)
#     -Addon   — имя аддона из csgo_addons (тот же, где модели игроков)
#     -Porter  — папка CS2-AG2-Port (если не нашлась сама)
#     -VdataOnly — только пересобрать weapons.vdata (после обновления CS2), модели не трогать
#
# ВАЖНО: weapons.vdata в аддоне заменяет игровой целиком. После крупного обновления CS2 (новые оружия, баланс)
# запусти с -VdataOnly и перезалей аддон — иначе в игре останутся старые параметры оружия.

param(
    [Parameter(Mandatory = $true)][string]$Addon,
    [string]$Source = "",
    [string]$Porter = "",
    [string]$S2V = "$env:USERPROFILE\s2v\Source2Viewer-CLI.exe",
    [string]$CS2Path = "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive",
    [switch]$VdataOnly
)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Say($ok, $msg) { if ($ok) { Write-Host "  OK  $msg" -ForegroundColor Green } else { Write-Host "  !!  $msg" -ForegroundColor Red } }
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName()
    try {
        $q = $Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
        Start-Process -FilePath $Exe -ArgumentList $q -NoNewWindow -Wait -RedirectStandardOutput $o -RedirectStandardError $e | Out-Null
        return ((Get-Content $o -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $e -Raw -ErrorAction SilentlyContinue))
    } finally { Remove-Item $o, $e -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- проверки
$RC = "$CS2Path\game\bin\win64\resourcecompiler.exe"
$PAK = "$CS2Path\game\csgo\pak01_dir.vpk"
$CONTENT = "$CS2Path\content\csgo_addons\$Addon"
$GAME = "$CS2Path\game\csgo_addons\$Addon"
Write-Host "`nTASHER: модели оружия -> аддон '$Addon'`n" -ForegroundColor Cyan
foreach ($p in @(@{p = $RC; n = "resourcecompiler (CS2 Workshop Tools)" }, @{p = $S2V; n = "Source2Viewer-CLI" }, @{p = $PAK; n = "pak01_dir.vpk" }, @{p = $CONTENT; n = "аддон в content\csgo_addons" })) {
    if (-not (Test-Path $p.p)) { Say $false "не найден $($p.n): $($p.p)"; exit 1 }
}
if (-not $VdataOnly) {
    if (-not $Source -or -not (Test-Path $Source)) { Say $false "укажи -Source — папку с распакованными архивами оружия"; exit 1 }
}
$gi = Get-Content "$CS2Path\game\csgo\gameinfo.gi" -Raw
if ($gi -notmatch '"include"\s+"weapons"') {
    Write-Warning 'В gameinfo.gi нет строки  "include" "weapons"  — без неё Workshop Manager не упакует модели оружия. Добавь её рядом с "include" "characters".'
}

# ---------------------------------------------------------------- 1. модели
# Свои известные модели: имя файла -> ключ на сайте и название. Незнакомые получат ключ из имени файла.
$KNOWN = @{
    "blooming_rose_ag2"      = @("rose", "Нож «Роза»")
    "blue_tiger_talon_ag2"   = @("tigertalon", "Коготь «Синий тигр»")
    "energy_kukri_ag2"       = @("energykukri", "Энерго-кукри")
    "ai_sword1_cord_ag2"     = @("aisword", "AI-меч")
    "mind_eye_cord_ag2"      = @("mindeye", "Mind Eye")
    "neco_deagle_ag2"        = @("necodeagle", "Desert Eagle «Neco»")
    "sanic_mp5_ag2"          = @("sanicmp5", "MP5 «Sanic»")
    "this_is_fine_m4a4_ag2"  = @("thisisfine", "M4A4 «This is fine»")
}

# какие модели берём: из -Source, а при -VdataOnly — уже собранные в аддоне
$models = @()
$scanDir = $(if ($VdataOnly) { "$GAME\weapons" } else { $Source })
foreach ($f in (Get-ChildItem $scanDir -Recurse -Filter *.vmdl_c -ErrorAction SilentlyContinue)) {
    $d = Invoke-Native $S2V @("-i", $f.FullName, "--block", "DATA")
    $mn = [regex]::Match($d, 'm_name\s*=\s*"([^"]+)"')
    if (-not $mn.Success) { continue }
    $path = $mn.Groups[1].Value -replace '\\', '/'
    if ($path -notlike "weapons/*") { continue }
    if ($path -notmatch '\.vmdl$') { $path += ".vmdl" }
    $rerl = Invoke-Native $S2V @("-i", $f.FullName, "--block", "RERL")
    $sk = [regex]::Match($rerl + "`n" + $d, 'animation/skeletons/weapons/[a-z0-9_]+\.vnmskel')
    $models += [pscustomobject]@{ File = $f.FullName; Path = $path; Name = [IO.Path]::GetFileNameWithoutExtension($path); Skel = $(if ($sk.Success) { $sk.Value } else { "" }) }
}
$models = @($models | Sort-Object Path -Unique)
if (-not $models.Count) { Say $false "не нашёл ни одной модели оружия (weapons/....vmdl_c) в $scanDir"; exit 1 }
Write-Host "Нашёл моделей оружия: $($models.Count)" -ForegroundColor DarkGray
foreach ($m in $models) {
    if (-not $m.Skel) { Write-Warning "$($m.Name): в модели нет скелета AnimGraph2 (старая модель) — пропускаю, в CS2 она работать не будет" }
}
$models = @($models | Where-Object { $_.Skel })
if (-not $models.Count) { exit 1 }

if (-not $VdataOnly) {
    # CS2-AG2-Port умеет разбирать и собирать модели, но берёт только модели игроков и переделывает анимации.
    # Делаем его копию для оружия: берём любые модели из weapons/ и пропускаем шаг переделки (они уже AnimGraph2).
    if (-not $Porter) {
        $cand = Get-ChildItem "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", "$env:USERPROFILE" -Recurse -Depth 3 -Filter Port-Model.ps1 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cand) { $Porter = $cand.DirectoryName }
    }
    if (-not $Porter -or -not (Test-Path "$Porter\Port-Model.ps1")) { Say $false "не нашёл CS2-AG2-Port (Port-Model.ps1). Укажи папку: -Porter `"C:\...\CS2-AG2-Port`""; exit 1 }
    $pm = [IO.File]::ReadAllText("$Porter\Port-Model.ps1")
    $a1 = '        # A player model has a full body skeleton.'
    $b1 = 'if (-not $hasBody) { $skipped += "$name ($($bones.Count) bones, no body skeleton)"; continue }'
    $a2 = '        # Already ported? Say so plainly'
    $b2 = '        # 4. compile'
    $i1 = $pm.IndexOf($a1); $j1 = $pm.IndexOf($b1); $i2 = $pm.IndexOf($a2); $j2 = $pm.IndexOf($b2)
    if ($i1 -lt 0 -or $j1 -lt $i1 -or $i2 -lt 0 -or $j2 -lt $i2) { Say $false "эта версия CS2-AG2-Port не подходит (не нашёл нужные места в Port-Model.ps1). Скачай свежую или напиши мне."; exit 1 }
    $pm = $pm.Substring(0, $i1) + '        if ($intern -notlike "weapons/*") { $skipped += "$name (не оружие)"; continue }' + $pm.Substring($j1 + $b1.Length)
    $i2 = $pm.IndexOf($a2); $j2 = $pm.IndexOf($b2)
    $pm = $pm.Substring(0, $i2) + "        # оружие уже в AnimGraph2 — переделка не нужна`r`n" + $pm.Substring($j2)
    $gen = "$Porter\Port-Weapon.gen.ps1"
    [IO.File]::WriteAllText($gen, $pm, (New-Object System.Text.UTF8Encoding($true)))

    Write-Host "`n1. Переношу модели в аддон (это несколько минут)..." -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File $gen -Source $Source -All -Force -Addon $Addon -S2V $S2V -CS2Path $CS2Path | Out-Host
    $fail = @()
    foreach ($m in $models) {
        $out = "$GAME\" + ($m.Path -replace '/', '\') + "_c"
        if (Test-Path $out) { Say $true "$($m.Name) собрана в аддоне" } else { Say $false "$($m.Name) не собралась — смотри лог выше"; $fail += $m.Name }
    }
    $models = @($models | Where-Object { $fail -notcontains $_.Name })
    if (-not $models.Count) { exit 1 }
}

# ---------------------------------------------------------------- 2. weapons.vdata
Write-Host "`n2. Собираю weapons.vdata из текущей версии игры..." -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP "tasher_vdata"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$null = Invoke-Native $S2V @("-i", $PAK, "-o", $tmp, "-f", "scripts/weapons.vdata_c", "-d")
$src = Get-ChildItem $tmp -Recurse -Filter weapons.vdata -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $src) { Say $false "Source2Viewer не смог достать scripts/weapons.vdata из игры"; exit 1 }
$text = [IO.File]::ReadAllText($src.FullName, [Text.Encoding]::UTF8) -replace "`r`n", "`n"
$L = $text -split "`n"

# записи верхнего уровня: имя (в т.ч. в кавычках, "526") -> строки начала и конца
$blocks = [ordered]@{}
$depth = 0; $i = 0
while ($i -lt $L.Count) {
    $s = $L[$i].Trim()
    if ($depth -eq 1 -and $i + 1 -lt $L.Count -and $L[$i + 1].Trim() -eq '{') {
        $mm = [regex]::Match($s, '^"?([A-Za-z0-9_]+)"?\s*=\s*$')
        if ($mm.Success) {
            $dd = 0; $j = $i + 1
            while ($j -lt $L.Count) {
                $dd += ([regex]::Matches($L[$j], '\{')).Count - ([regex]::Matches($L[$j], '\}')).Count
                if ($dd -eq 0) { break }
                $j++
            }
            $blocks[$mm.Groups[1].Value] = @($i, $j)
            $i = $j + 1; continue
        }
    }
    $depth += ([regex]::Matches($L[$i], '\{')).Count - ([regex]::Matches($L[$i], '\}')).Count
    $i++
}
if ($blocks.Count -lt 50) { Say $false "weapons.vdata разобран неправильно (записей: $($blocks.Count)) — напиши мне, приложи файл $($src.FullName)"; exit 1 }
function Field($key, $name) {
    $r = $blocks[$key]; $t = ($L[$r[0]..$r[1]] -join "`n")
    $m = [regex]::Match($t, "(?m)^\s*$name\s*=\s*(?:resource_name:)?`"([^`"]+)`"")
    if ($m.Success) { return $m.Groups[1].Value } else { return "" }
}

$added = @(); $cmds = @()
$lastClose = -1
for ($k = $L.Count - 1; $k -ge 0; $k--) { if ($L[$k].Trim() -eq '}') { $lastClose = $k; break } }
$newLines = New-Object System.Collections.Generic.List[string]
foreach ($m in $models) {
    # шаблон: запись оружия с тем же скелетом; номерная ("526", "1") — сразу даёт номер предмета
    $cands = @($blocks.Keys | Where-Object { $_ -notlike "*_prefab" -and $_ -notlike "weapon_tasher_*" -and (Field $_ "m_szAnimSkeleton") -eq $m.Skel })
    $tpl = @($cands | Where-Object { $_ -match '^\d+$' } | Sort-Object { [int]$_ }) | Select-Object -First 1
    if (-not $tpl) { $tpl = $cands | Select-Object -First 1 }
    if (-not $tpl) { Write-Warning "$($m.Name): в игре нет оружия со скелетом $($m.Skel) — пропускаю"; continue }
    $baseName = Field $tpl "m_szName"
    $def = $(if ($tpl -match '^\d+$') { [int]$tpl } else { 0 })
    if (-not $def) { $num = @($blocks.Keys | Where-Object { $_ -match '^\d+$' -and (Field $_ "m_szName") -eq $baseName }) | Select-Object -First 1; if ($num) { $def = [int]$num } }
    $gear = Field $tpl "m_GearSlot"
    $isKnife = ($baseName -match 'knife|bayonet') -or ($gear -eq "GEAR_SLOT_KNIFE")
    $kind = $(if ($isKnife) { "knife" } elseif ($gear -eq "GEAR_SLOT_PISTOL") { "pistol" } else { "gun" })

    $key = $null; $title = $null
    if ($KNOWN.ContainsKey($m.Name)) { $key = $KNOWN[$m.Name][0]; $title = $KNOWN[$m.Name][1] }
    else { $key = (($m.Name -replace '_ag2$', '') -replace '[^a-z0-9]', ''); if ($key.Length -gt 16) { $key = $key.Substring(0, 16) }; $title = $m.Name }
    $vd = "weapon_tasher_$key"
    if ($blocks.Contains($vd)) { Write-Warning "$vd уже есть в игровом файле — пропускаю"; continue }

    # копия записи-шаблона: другое имя и путь к модели, всё остальное (анимации, звуки, урон) как у шаблона
    $r = $blocks[$tpl]
    $blk = @($L[$r[0]..$r[1]])
    $indent = [regex]::Match($blk[0], '^\s*').Value
    $blk[0] = "$indent$vd = "
    $modelSet = $false; $nameSet = $false
    for ($q = 1; $q -lt $blk.Count; $q++) {
        if (-not $nameSet -and $blk[$q] -match '^\s*m_szName\s*=') { $blk[$q] = ($blk[$q] -replace '=\s*".*$', "= `"$vd`""); $nameSet = $true }
        elseif ($blk[$q] -match '^\s*(m_szWorldModel|m_szModel_AG2)\s*=\s*resource_name:') { $blk[$q] = ($blk[$q] -replace 'resource_name:".*$', "resource_name:`"$($m.Path)`""); $modelSet = $true }
    }
    if (-not $modelSet) { Write-Warning "$($m.Name): в записи $tpl нет поля модели (m_szWorldModel) — формат игры изменился, напиши мне"; continue }
    if (-not $nameSet) { $blk = @($blk[0], $blk[1], "$indent    m_szName = `"$vd`"") + $blk[2..($blk.Count - 1)] }
    foreach ($x in $blk) { $newLines.Add($x) }
    $added += [pscustomobject]@{ Model = $m.Name; Vdata = $vd; Template = "$tpl ($baseName)"; Def = $def; Kind = $kind }
    $srvBase = $(if ($isKnife) { "weapon_knife" } else { $baseName })
    $cmds += "NORESTART=1 bash /opt/tasher/server/deploy/weapon-model-add.sh $key `"$title`" $kind $srvBase $vd $($m.Path) $def"
}
if (-not $added.Count) { Say $false "ни одной записи не добавлено"; exit 1 }

$outL = New-Object System.Collections.Generic.List[string]
for ($q = 0; $q -lt $lastClose; $q++) { $outL.Add($L[$q]) }
foreach ($x in $newLines) { $outL.Add($x) }
for ($q = $lastClose; $q -lt $L.Count; $q++) { $outL.Add($L[$q]) }
$final = ($outL -join "`r`n")
# скобки должны сойтись
$bal = ([regex]::Matches($final, '\{')).Count - ([regex]::Matches($final, '\}')).Count
if ($bal -ne 0) { Say $false "ошибка сборки: скобки не сходятся ($bal) — ничего не записал"; exit 1 }

New-Item -ItemType Directory -Force -Path "$CONTENT\scripts" | Out-Null
$vdSrc = "$CONTENT\scripts\weapons.vdata"
[IO.File]::WriteAllText($vdSrc, $final, $utf8)
# исходник в game\ мешает: игра берёт его вместо собранного
Remove-Item "$GAME\scripts\weapons.vdata" -Force -ErrorAction SilentlyContinue
$before = $(if (Test-Path "$GAME\scripts\weapons.vdata_c") { (Get-Item "$GAME\scripts\weapons.vdata_c").LastWriteTime } else { [datetime]::MinValue })
$log = Invoke-Native $RC @("-i", $vdSrc)
Set-Content (Join-Path $env:TEMP "tasher_vdata_compile.log") -Value $log
$outC = "$GAME\scripts\weapons.vdata_c"
if (-not (Test-Path $outC) -or (Get-Item $outC).LastWriteTime -le $before -or $log -match 'ERROR: 0 compiled') {
    ($log -split "`n" | Select-String 'ERROR|Error' | Select-Object -First 8) | Out-Host
    Say $false "weapons.vdata не скомпилировался — лог: $env:TEMP\tasher_vdata_compile.log"; exit 1
}
Say $true "weapons.vdata собран: $outC"

# ---------------------------------------------------------------- 3. итог
Write-Host "`nДобавлено записей: $($added.Count)" -ForegroundColor Cyan
$added | Format-Table Model, Vdata, Template, Def, Kind -AutoSize | Out-Host
$cmdFile = "$env:USERPROFILE\Desktop\tasher-weapons-commands.txt"
($cmds + "systemctl restart cs2") -join "`n" | Set-Content $cmdFile -Encoding UTF8
Write-Host @"
Дальше:
  1. ПРОВЕРКА У СЕБЯ (обязательно, до сервера): Workshop Tools -> запусти CS2 с аддоном '$Addon',
     в консоли:  map de_dust2  ->  sv_cheats 1  ->  give $($added[0].Vdata)
     Должна появиться модель от первого лица и со стороны (thirdperson). Проверь так каждую запись.
     Если игра падает при загрузке карты — НЕ заливай, пришли мне скрин консоли.
  2. Workshop Manager -> аддон -> Update (загрузка должна вырасти на размер моделей).
  3. Команды для сервера сохранены в: $cmdFile
     (передай их серверу вместе с перезапуском).
"@
