// TASHER Style: тег и цвет ника в чате, тег в таблице счёта, цвет дыма, эффекты (убийство, звук, трассеры, след гранат),
// команды !rank !top !tk !quests !pass, приветствие статусов (только сообщение), особые раунды — по данным с сайта tashercs.ru.
// UPD: из звуков в игре остался только купленный звук убийства.
// Сайт пишет готовые значения в таблицу tasher_style (база weaponpaints), плагин перечитывает её раз в 20 секунд
// и сразу по команде сервера css_tasher_style_reload (сайт присылает её по RCON после покупки).
using System.Collections.Concurrent;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using MySqlConnector;

namespace TasherStyle;

public class StyleConfig : BasePluginConfig
{
    [JsonPropertyName("Host")] public string Host { get; set; } = "127.0.0.1";
    [JsonPropertyName("Port")] public uint Port { get; set; } = 3306;
    [JsonPropertyName("User")] public string User { get; set; } = "wp";
    [JsonPropertyName("Password")] public string Password { get; set; } = "";
    [JsonPropertyName("Database")] public string Database { get; set; } = "weaponpaints";
    [JsonPropertyName("ReloadSeconds")] public float ReloadSeconds { get; set; } = 20f;
    // Очки рейтинга месяца с сайта в поле Premier (CS Rating) в Tab, как в режиме «Премьер».
    // Работает только при FollowCS2ServerGuidelines=false (как и WeaponPaints — на нашем сервере так и настроено).
    [JsonPropertyName("PremierScoreboardEnabled")] public bool PremierScoreboardEnabled { get; set; } = true;
    // звуки убийства: код с сайта -> файл звука из игры (слышит только убивший)
    [JsonPropertyName("KillSounds")] public Dictionary<string, string> KillSounds { get; set; } = new()
    {
        ["ding"] = "sounds/training/bell_normal.vsnd",
        ["drum"] = "sounds/ui/deathmatch_kill_bonus.vsnd",
        ["bell"] = "sounds/buttons/bell1.vsnd",
        ["8bit"] = "sounds/ui/armsrace_level_up.vsnd",
        ["coin"] = "sounds/ui/coin_pickup_01.vsnd",
    };
    // звук MVP раунда: код с сайта -> MVP-тема музыкального набора из самой игры (слышат все на сервере).
    // Пути — как у наборов CS:GO (music/<набор>/roundmvpanthem_01); если в игре путь другой, его можно поправить здесь, в конфиге.
    [JsonPropertyName("MvpSounds")] public Dictionary<string, string> MvpSounds { get; set; } = DefaultMvpSounds();
    public static Dictionary<string, string> DefaultMvpSounds() => new()
    {
        ["csgo"] = "sounds/music/valve_csgo_01/roundmvpanthem_01.vsnd", // Valve — CS:GO
        ["crimson"] = "sounds/music/danielsadowski_01/roundmvpanthem_01.vsnd", // Daniel Sadowski — Crimson Assault
        ["sharpened"] = "sounds/music/noisia_01/roundmvpanthem_01.vsnd", // Noisia — Sharpened
        ["highnoon"] = "sounds/music/feedme_01/roundmvpanthem_01.vsnd", // Feed Me — High Noon
        ["iam"] = "sounds/music/awolnation_01/roundmvpanthem_01.vsnd", // AWOLNATION — I Am
        ["diamonds"] = "sounds/music/mordfustang_01/roundmvpanthem_01.vsnd", // Mord Fustang — Diamonds
        ["moments"] = "sounds/music/darude_01/roundmvpanthem_01.vsnd", // Darude — Moments
        ["disgusting"] = "sounds/music/beartooth_01/roundmvpanthem_01.vsnd", // Beartooth — Disgusting
        ["wops"] = "sounds/music/midnightriders_01/roundmvpanthem_01.vsnd", // Winter Ops (эксклюзив пропуска): Midnight Riders — All I Want for Christmas
    };
    // UPD: не используется — приветствие без звука. Оставлено, чтобы старые конфиги читались без ошибок.
    [JsonPropertyName("GreetSounds")] public Dictionary<string, string> GreetSounds { get; set; } = new()
    {
        ["VIP"] = "sounds/ui/item_drop2_uncommon.vsnd",
        ["PREMIUM"] = "sounds/ui/item_drop3_rare.vsnd",
        ["ELITE"] = "sounds/ui/item_drop4_mythical.vsnd",
        ["LEGEND"] = "sounds/ui/item_drop5_legendary.vsnd",
        ["TITAN"] = "sounds/ui/item_drop6_ancient.vsnd",
        ["KING"] = "sounds/ui/item_drop6_ancient.vsnd",
    };
    // одного и того же игрока приветствуем не чаще, чем раз в столько минут (перезаходы не спамят)
    [JsonPropertyName("GreetCooldownMinutes")] public int GreetCooldownMinutes { get; set; } = 15;
    [JsonPropertyName("Site")] public string Site { get; set; } = "tashercs.ru";
    // реклама сайта в чате: раз в столько минут (0 — выключено), тексты по кругу
    [JsonPropertyName("AdvertMinutes")] public int AdvertMinutes { get; set; } = 3;
    [JsonPropertyName("Adverts")] public List<string> Adverts { get; set; } = TasherStyle.DefaultAdverts();
    // ограничение на число лучей эффектов одновременно (защита от перегрузки сервера)
    [JsonPropertyName("MaxBeams")] public int MaxBeams { get; set; } = 320;
    // особые раунды и серии убийств
    [JsonPropertyName("FunEnabled")] public bool FunEnabled { get; set; } = false; // особые раунды выключены (25.11.2026)
    [JsonPropertyName("SpecialEveryMin")] public int SpecialEveryMin { get; set; } = 2;
    [JsonPropertyName("SpecialEveryMax")] public int SpecialEveryMax { get; set; } = 3;
    [JsonPropertyName("SpecialMinHumans")] public int SpecialMinHumans { get; set; } = 1;
    [JsonPropertyName("SpecialModes")] public List<string> SpecialModes { get; set; } = new() { "knife", "deagle", "awp", "scout", "zeus", "onehp", "nades", "invis", "wh", "hs", "bhop", "vampire", "ammo" };
    // Длинная карта: до стольких побед одной из команд, без смены сторон; потом счёт обнуляется (0 — обычный матч)
    [JsonPropertyName("WinScore")] public int WinScore { get; set; } = 100;
    // общий голосовой чат: обе команды слышат друг друга, живые не слышат мёртвых
    [JsonPropertyName("AllTalk")] public bool AllTalk { get; set; } = true;
    // Серии убийств (DOUBLE / MULTI / ULTRA / MONSTER KILL): убийства подряд с паузой не больше StreakWindow секунд
    [JsonPropertyName("StreaksEnabled")] public bool StreaksEnabled { get; set; } = true;
    [JsonPropertyName("StreakWindow")] public float StreakWindow { get; set; } = 4f;
    // звуки серий — встроенные звуки CS2: first — первая кровь раунда, 2…5 — серия
    [JsonPropertyName("StreakSounds")] public Dictionary<string, string> StreakSounds { get; set; } = new()
    {
        ["first"] = "sounds/ui/deathmatch_bonuskill.vsnd",
        ["2"] = "sounds/ui/armsrace_kill_01.vsnd",
        ["3"] = "sounds/ui/armsrace_kill_02.vsnd",
        ["4"] = "sounds/ui/armsrace_kill_03.vsnd",
        ["5"] = "sounds/ui/armsrace_final_kill_tone.vsnd",
        ["special"] = "sounds/ui/bonus_alert_start.vsnd",
    };
}

public record PlayerStyle(string ChatTag, string NameColor, string ScoreTag, string Smoke, string KillFx, string KillSnd, string Trail, string Tracer, string MvpSnd = "");

public partial class TasherStyle : BasePlugin, IPluginConfig<StyleConfig>
{
    public override string ModuleName => "TASHER Style";
    public override string ModuleVersion => "1.5.0";
    public override string ModuleAuthor => "tashercs.ru";

    public StyleConfig Config { get; set; } = new();
    private volatile Dictionary<ulong, PlayerStyle> _styles = new();
    private readonly ConcurrentDictionary<ulong, string> _appliedClan = new();
    private int _loading;
    private volatile bool _fxColumns; // в таблице есть колонки эффектов

    public void OnConfigParsed(StyleConfig config)
    {
        // новые звуки MVP добавляются и в старый конфиг (свои правки владельца не трогаем)
        foreach (var (k, v) in StyleConfig.DefaultMvpSounds()) config.MvpSounds.TryAdd(k, v);
        Config = config;
    }

    private string ConnString => new MySqlConnectionStringBuilder
    {
        Server = Config.Host, Port = Config.Port, UserID = Config.User, Password = Config.Password, Database = Config.Database,
        Pooling = true, ConnectionTimeout = 5, DefaultCommandTimeout = 5
    }.ConnectionString;

    public override void Load(bool hotReload)
    {
        AddCommandListener("say", (p, i) => HandleChat(p, i, false), HookMode.Pre);
        AddCommandListener("say_team", (p, i) => HandleChat(p, i, true), HookMode.Pre);
        RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
        LoadEffects();
        LoadInfo();
        LoadPunish();
        LoadFun();
        LoadMatch();
        LoadAdverts();
        LoadTestBots();
        // рейтинг в Tab игра сбрасывает постоянно — выставляем каждый тик, как плагины рангов
        RegisterListener<Listeners.OnTick>(() => { if (Config.PremierScoreboardEnabled) foreach (var pl in Utilities.GetPlayers()) ApplyPremierRanking(pl); });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (e.Userid is { } p) Server.NextFrame(() => { ApplyScoreboard(p); ApplyPremierRanking(p); });
            return HookResult.Continue;
        });
        AddTimer(Math.Max(5f, Config.ReloadSeconds), ReloadAsync, CounterStrikeSharp.API.Modules.Timers.TimerFlags.REPEAT);
        Task.Run(async () =>
        {
            try
            {
                await using var c = new MySqlConnection(ConnString);
                await c.OpenAsync();
                await using var cmd = c.CreateCommand();
                cmd.CommandText = @"CREATE TABLE IF NOT EXISTS tasher_style (
                    steamid BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                    chat_tag VARCHAR(64) NOT NULL DEFAULT '',
                    name_color VARCHAR(16) NOT NULL DEFAULT '',
                    score_tag VARCHAR(16) NOT NULL DEFAULT '',
                    smoke VARCHAR(16) NOT NULL DEFAULT '',
                    kill_fx VARCHAR(16) NOT NULL DEFAULT '',
                    kill_snd VARCHAR(16) NOT NULL DEFAULT '',
                    trail VARCHAR(16) NOT NULL DEFAULT '',
                    tracer VARCHAR(16) NOT NULL DEFAULT '',
                    mvp_snd VARCHAR(16) NOT NULL DEFAULT ''
                ) DEFAULT CHARSET=utf8mb4";
                await cmd.ExecuteNonQueryAsync();
                // таблица от прошлой версии плагина — добавляем колонки эффектов
                var ok = true;
                foreach (var col in FxColumns)
                {
                    await using var chk = c.CreateCommand();
                    chk.CommandText = "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_style' AND COLUMN_NAME=@c";
                    chk.Parameters.AddWithValue("@c", col);
                    if (Convert.ToInt64(await chk.ExecuteScalarAsync()) > 0) continue;
                    try
                    {
                        await using var alter = c.CreateCommand();
                        alter.CommandText = $"ALTER TABLE tasher_style ADD COLUMN `{col}` VARCHAR(16) NOT NULL DEFAULT ''";
                        await alter.ExecuteNonQueryAsync();
                    }
                    catch (Exception e) { ok = false; Logger.LogError("[TASHER Style] не удалось добавить колонку {Col}: {Error}", col, e.Message); }
                }
                _fxColumns = ok;
                await CreateInfoTablesAsync(c);
                await CreatePunishTableAsync(c);
                await CreatePrefsTableAsync(c);
                await LoadPrefsAsync(c);
            }
            catch (Exception e) { Logger.LogError("[TASHER Style] база недоступна: {Error}", e.Message); }
            ReloadAsync();
        });
    }

    [ConsoleCommand("css_tasher_style_reload", "Перечитать стили игроков с сайта")]
    public void OnReloadCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) return; // только из консоли сервера (RCON)
        ReloadAsync();
        info.ReplyToCommand("[TASHER Style] перечитываю");
    }

    private int _reloadAgain;
    private void ReloadAsync()
    {
        if (Interlocked.Exchange(ref _loading, 1) == 1) { Interlocked.Exchange(ref _reloadAgain, 1); return; }
        Task.Run(async () =>
        {
            try
            {
                do
                {
                    Interlocked.Exchange(ref _reloadAgain, 0);
                    await using var c = new MySqlConnection(ConnString);
                    await c.OpenAsync();
                    try
                    {
                        var map = new Dictionary<ulong, PlayerStyle>();
                        await using (var cmd = c.CreateCommand())
                        {
                            var fx = _fxColumns;
                            cmd.CommandText = fx
                                ? "SELECT steamid, chat_tag, name_color, score_tag, smoke, kill_fx, kill_snd, trail, tracer, mvp_snd FROM tasher_style"
                                : "SELECT steamid, chat_tag, name_color, score_tag, smoke FROM tasher_style";
                            await using var r = await cmd.ExecuteReaderAsync();
                            while (await r.ReadAsync())
                                map[r.GetUInt64(0)] = new PlayerStyle(r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4),
                                    fx ? r.GetString(5) : "", fx ? r.GetString(6) : "", fx ? r.GetString(7) : "", fx ? r.GetString(8) : "", fx ? r.GetString(9) : "");
                        }
                        _styles = map;
                        Server.NextFrame(() =>
                        {
                            foreach (var p in Utilities.GetPlayers()) { ApplyScoreboard(p); ApplyPremierRanking(p); }
                        });
                    }
                    catch (Exception e) { Logger.LogError("[TASHER Style] не удалось прочитать стили: {Error}", e.Message); }
                    // данные для !rank, !top, !tk, !quests и приветствия
                    try { await LoadInfoAsync(c); }
                    catch (Exception e) { Logger.LogError("[TASHER Style] не удалось прочитать данные игроков: {Error}", e.Message); }
                    // мут и гег
                    try { await LoadPunishAsync(c); }
                    catch (Exception e) { Logger.LogError("[TASHER Style] не удалось прочитать муты и геги: {Error}", e.Message); }
                } while (Interlocked.Exchange(ref _reloadAgain, 0) == 1);
            }
            catch (Exception e) { Logger.LogError("[TASHER Style] база недоступна: {Error}", e.Message); }
            finally { Interlocked.Exchange(ref _loading, 0); }
        });
    }

    private PlayerStyle? StyleOf(CCSPlayerController p) => _styles.TryGetValue(p.SteamID, out var s) ? s : null;

    // --- чат ---
    private HookResult HandleChat(CCSPlayerController? player, CommandInfo info, bool teamOnly)
    {
        if (player is not { IsValid: true } || player.IsBot || player.IsHLTV) return HookResult.Continue;
        var raw = info.GetArg(1);
        if (string.IsNullOrWhiteSpace(raw)) return HookResult.Continue;
        if (BlockGagged(player, raw)) return HookResult.Handled;
        if (IsChatTrigger(raw))
        {
            // «/команда» CS# и так не показывает в чате; «!команда» видит только сам игрок, остальным она не приходит
            if (raw.TrimStart()[0] == '/') return HookResult.Continue;
            var cmdText = StripControl(raw.TrimStart()[1..]).Trim();
            if (cmdText.Length == 0) return HookResult.Handled;
            player.PrintToChat($" {ChatColors.Grey}{StripControl(player.PlayerName)}: {ChatColors.Default}{StripControl(raw.Trim())}");
            var cmdName = cmdText.Split(' ', 2)[0].ToLowerInvariant();
            var cmdArgs = cmdText.Length > cmdName.Length ? cmdText[cmdName.Length..] : "";
            // выполняем команду так же, как CS# выполнил бы её из чата: css_<имя> <аргументы>
            if (cmdName.All(ch => char.IsLetterOrDigit(ch) || ch == '_'))
                player.ExecuteClientCommandFromServer($"css_{cmdName}{cmdArgs.Replace(";", "")}");
            return HookResult.Handled;
        }
        // управляющие символы — это цвета чата CS2: без очистки игрок мог перекрасить строку и подделать чужой тег
        var message = StripControl(raw);
        if (string.IsNullOrWhiteSpace(message)) return HookResult.Handled;
        var s = StyleOf(player);
        var team = player.Team;
        // UPD: даже новый игрок без записи в базе получает серверный тег «Новенький».
        var tag = s == null || string.IsNullOrEmpty(s.ChatTag)
            ? $"{ChatColors.Grey}[Новенький]" : TagColors.ResolveTokens(s.ChatTag, team);
        var nameColor = s == null || string.IsNullOrEmpty(s.NameColor)
            ? ChatColors.ForTeam(team) : TagColors.ColorChar(s.NameColor, team);
        // Градиентный ник сдвигает цветовую фазу при каждом новом сообщении.
        var plainName = StripControl(player.PlayerName);
        var displayName = s?.NameColor is "grad-sunset" or "grad-toxic"
            ? AnimatedChatName(plainName, s.NameColor, team)
            : $"{nameColor}{plainName}";
        var dead = player.PawnIsAlive ? "" : $"{ChatColors.Grey}*DEAD* ";
        var teamPrefix = teamOnly ? $"{ChatColors.Default}(team) " : "";
        var line = $" {dead}{(tag.Length > 0 ? tag + " " : "")}{teamPrefix}{displayName}{ChatColors.Default}: {message}";

        if (teamOnly)
        {
            foreach (var receiver in Utilities.GetPlayers())
                if (receiver is { IsValid: true, IsBot: false } && receiver.Team == player.Team)
                    receiver.PrintToChat(line);
        }
        else Server.PrintToChatAll(line);
        return HookResult.Handled;
    }

    // CS2 не поддерживает перекрашивание старых строк чата: фаза меняется при новых сообщениях.
    private static string AnimatedChatName(string name, string mode, CsTeam team)
    {
        var palette = mode == "grad-sunset"
            ? new[] { "red", "orange", "gold", "lightyellow", "magenta" }
            : new[] { "green", "lime", "lightblue", "blue", "lightpurple" };
        var phase = (int)((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 500) % palette.Length);
        var sb = new System.Text.StringBuilder(name.Length * 2);
        for (var i = 0; i < name.Length; i++)
        {
            sb.Append(TagColors.ColorChar(palette[(i + phase) % palette.Length], team));
            sb.Append(name[i]);
        }
        return sb.ToString();
    }

    // убирает управляющие символы (цвета чата CS2 \x01–\x10, переносы и т.п.)
    internal static string StripControl(string? s)
    {
        if (string.IsNullOrEmpty(s)) return string.Empty;
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var ch in s) if (!char.IsControl(ch)) sb.Append(ch);
        return sb.ToString();
    }

    private static bool IsChatTrigger(string message)
    {
        var t = message.TrimStart();
        if (t.Length == 0) return false;
        foreach (var tr in CoreConfig.PublicChatTrigger) if (!string.IsNullOrEmpty(tr) && t.StartsWith(tr, StringComparison.Ordinal)) return true;
        foreach (var tr in CoreConfig.SilentChatTrigger) if (!string.IsNullOrEmpty(tr) && t.StartsWith(tr, StringComparison.Ordinal)) return true;
        return false;
    }

    // Отдельное штатное поле CS Rating (Premier) в Tab; это НЕ текст в Clan/ScoreTag.
    // CSS предупреждает о возможном бане GSLT при изменении матчмейкинговых полей.
    // Поэтому функция только по явному opt-in и не пытается обойти защиту CSS.
    private bool _premierWarningLogged;
    private void ApplyPremierRanking(CCSPlayerController player)
    {
        if (!Config.PremierScoreboardEnabled ||
            player is not { IsValid: true, IsBot: false, IsHLTV: false }) return;
        if (CoreConfig.FollowCS2ServerGuidelines)
        {
            if (!_premierWarningLogged)
            {
                _premierWarningLogged = true;
                Logger.LogWarning("[TASHER Style] PremierScoreboardEnabled запрошен, но заблокирован FollowCS2ServerGuidelines. Защиту не отключаем из-за риска бана GSLT.");
            }
            return;
        }
        var info = InfoOf(player);
        if (info == null) return; // без данных с сайта не подменяем личный рейтинг Steam
        var pts = Math.Clamp(info.Pts, 0, 39999);
        var kind = (sbyte)(pts > 0 ? 11 : 0); // 11 — Premier, 0 — без рейтинга
        try
        {
            // игра сама сбрасывает эти поля, поэтому их выставляют каждый тик (так делают все плагины рангов, например K4 MMRanks);
            // CS Rating виден только у тех, у кого не меньше 10 побед — ставим 10
            player.CompetitiveWins = 10;
            player.CompetitiveRanking = pts;
            player.CompetitiveRankType = kind;
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_iCompetitiveRankType");
        }
        catch (Exception ex)
        {
            if (!_premierWarningLogged)
            {
                _premierWarningLogged = true;
                Logger.LogWarning("[TASHER Style] CS2 не разрешил изменить Premier-отображение: {Error}", ex.Message);
            }
        }
    }

    // --- тег в таблице счёта ---
    private void ApplyScoreboard(CCSPlayerController player)
    {
        if (player is not { IsValid: true } || player.IsBot || player.IsHLTV) return;
        var want = StyleOf(player)?.ScoreTag ?? "";
        var had = _appliedClan.TryGetValue(player.SteamID, out var prev) ? prev : null;
        // В Tab-клановом теге оставляем только привилегию, без очков рейтинга.
        if (want.Length == 0 && had == null && string.IsNullOrEmpty(player.Clan)) return;
        if (had == want && player.Clan == want) return;
        player.Clan = want;
        Utilities.SetStateChanged(player, "CCSPlayerController", "m_szClan");
        if (want.Length == 0) _appliedClan.TryRemove(player.SteamID, out _); else _appliedClan[player.SteamID] = want;
    }

    // --- гранаты: цвет дыма и светящийся след ---
    private void OnEntitySpawned(CEntityInstance entity)
    {
        var name = entity.DesignerName;
        if (name == null || !name.EndsWith("_projectile", StringComparison.Ordinal)) return;
        var g = new CBaseCSGrenadeProjectile(entity.Handle);
        if (g.Handle == IntPtr.Zero) return;
        var isSmoke = name == "smokegrenade_projectile";
        Server.NextFrame(() => OnGrenade(g, isSmoke, 0));
    }

    private void OnGrenade(CBaseCSGrenadeProjectile g, bool isSmoke, int attempt)
    {
        if (!g.IsValid) return;
        CCSPlayerPawn? pawn = g.Thrower.Value;
        if (pawn is null && g.OwnerEntity.Value is { IsValid: true } owner) pawn = new CCSPlayerPawn(owner.Handle);
        var bc = pawn is { IsValid: true } ? pawn.Controller.Value : null;
        if (bc is null || !bc.IsValid)
        {
            if (attempt < 8) Server.NextFrame(() => OnGrenade(g, isSmoke, attempt + 1));
            return;
        }
        var controller = new CCSPlayerController(bc.Handle);
        var style = controller.IsValid && !controller.IsBot ? StyleOf(controller) : null;
        if (!controller.IsValid || controller.IsBot) return;
        if (isSmoke && style != null) ApplySmoke(new CSmokeGrenadeProjectile(g.Handle), style.Smoke);
        // белый след гранаты есть у всех; цветной — купленный на сайте; в !menu можно выключить
        var trailSpec = style is { Trail.Length: > 0 } ? style.Trail : DefaultWhite;
        if (PrefOn(controller.SteamID, OffTrail) && TryColor(trailSpec, out var col)) StartTrail(g, col, controller.SteamID, trailSpec.StartsWith("anim:") ? trailSpec[5..] : "");
    }

    private static void ApplySmoke(CSmokeGrenadeProjectile g, string smoke)
    {
        if (smoke.Length == 0 || !g.IsValid) return;
        float r, gr, b;
        if (smoke == "random")
        {
            r = Random.Shared.NextSingle() * 255f; gr = Random.Shared.NextSingle() * 255f; b = Random.Shared.NextSingle() * 255f;
        }
        else if (!TryRgb(smoke, out r, out gr, out b)) return;
        g.SmokeColor.X = r; g.SmokeColor.Y = gr; g.SmokeColor.Z = b;
        Utilities.SetStateChanged(g, "CSmokeGrenadeProjectile", "m_vSmokeColor");
    }

    // "r,g,b" -> числа 0..255
    internal static bool TryRgb(string s, out float r, out float g, out float b)
    {
        r = g = b = 0;
        var parts = s.Split(',');
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        const System.Globalization.NumberStyles ns = System.Globalization.NumberStyles.Float;
        return parts.Length == 3 && float.TryParse(parts[0], ns, inv, out r) && float.TryParse(parts[1], ns, inv, out g) && float.TryParse(parts[2], ns, inv, out b)
            && r is >= 0 and <= 255 && g is >= 0 and <= 255 && b is >= 0 and <= 255;
    }
}
