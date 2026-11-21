// TASHER Style: тег и цвет ника в чате, тег в таблице счёта, цвет дыма, эффекты (убийство, звук, трассеры, след гранат),
// команды !rank !top !tk !quests, приветствие статусов с музыкой, особые раунды и звуки серий — по данным с сайта tashercs.ru.
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
    // звуки убийства: код с сайта -> файл звука из игры (слышит только убивший)
    [JsonPropertyName("KillSounds")] public Dictionary<string, string> KillSounds { get; set; } = new()
    {
        ["ding"] = "sounds/training/bell_normal.vsnd",
        ["drum"] = "sounds/ui/deathmatch_kill_bonus.vsnd",
        ["bell"] = "sounds/buttons/bell1.vsnd",
        ["8bit"] = "sounds/ui/armsrace_level_up.vsnd",
        ["coin"] = "sounds/ui/coin_pickup_01.vsnd",
    };
    // приветствие игрока со статусом: короткая мелодия для всех на сервере (файлы звуков из самой игры)
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
    // ограничение на число лучей эффектов одновременно (защита от перегрузки сервера)
    [JsonPropertyName("MaxBeams")] public int MaxBeams { get; set; } = 600;
    // особые раунды и серии убийств
    [JsonPropertyName("FunEnabled")] public bool FunEnabled { get; set; } = true;
    [JsonPropertyName("SpecialEveryMin")] public int SpecialEveryMin { get; set; } = 2;
    [JsonPropertyName("SpecialEveryMax")] public int SpecialEveryMax { get; set; } = 3;
    [JsonPropertyName("SpecialMinHumans")] public int SpecialMinHumans { get; set; } = 1;
    [JsonPropertyName("SpecialModes")] public List<string> SpecialModes { get; set; } = new() { "knife", "deagle", "awp", "scout", "zeus", "onehp", "nades", "invis", "wh", "hs", "bhop", "vampire", "ammo" };
    // звуки серий (из самой игры, слышит только убивший): first — первая кровь, 2…5 — двойное…эйс; special — начало особого раунда (всем)
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

public record PlayerStyle(string ChatTag, string NameColor, string ScoreTag, string Smoke, string KillFx, string KillSnd, string Trail, string Tracer);

public partial class TasherStyle : BasePlugin, IPluginConfig<StyleConfig>
{
    public override string ModuleName => "TASHER Style";
    public override string ModuleVersion => "1.4.2";
    public override string ModuleAuthor => "tashercs.ru";

    public StyleConfig Config { get; set; } = new();
    private volatile Dictionary<ulong, PlayerStyle> _styles = new();
    private readonly ConcurrentDictionary<ulong, string> _appliedClan = new();
    private int _loading;
    private volatile bool _fxColumns; // в таблице есть колонки эффектов

    public void OnConfigParsed(StyleConfig config) => Config = config;

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
        LoadTestBots();
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (e.Userid is { } p) Server.NextFrame(() => ApplyScoreboard(p));
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
                    tracer VARCHAR(16) NOT NULL DEFAULT ''
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
                                ? "SELECT steamid, chat_tag, name_color, score_tag, smoke, kill_fx, kill_snd, trail, tracer FROM tasher_style"
                                : "SELECT steamid, chat_tag, name_color, score_tag, smoke FROM tasher_style";
                            await using var r = await cmd.ExecuteReaderAsync();
                            while (await r.ReadAsync())
                                map[r.GetUInt64(0)] = new PlayerStyle(r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4),
                                    fx ? r.GetString(5) : "", fx ? r.GetString(6) : "", fx ? r.GetString(7) : "", fx ? r.GetString(8) : "");
                        }
                        _styles = map;
                        Server.NextFrame(() =>
                        {
                            foreach (var p in Utilities.GetPlayers()) ApplyScoreboard(p);
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
        var message = info.GetArg(1);
        if (string.IsNullOrWhiteSpace(message)) return HookResult.Continue;
        if (BlockGagged(player, message)) return HookResult.Handled;
        if (IsChatTrigger(message)) return HookResult.Continue;
        var s = StyleOf(player);
        if (s == null || (string.IsNullOrEmpty(s.ChatTag) && string.IsNullOrEmpty(s.NameColor))) return HookResult.Continue;

        var team = player.Team;
        var tag = TagColors.ResolveTokens(s.ChatTag, team);
        var nameColor = string.IsNullOrEmpty(s.NameColor) ? ChatColors.ForTeam(team) : TagColors.ColorChar(s.NameColor, team);
        var dead = player.PawnIsAlive ? "" : $"{ChatColors.Grey}*DEAD* ";
        var teamPrefix = teamOnly ? $"{ChatColors.Default}(team) " : "";
        var line = $" {dead}{(tag.Length > 0 ? tag + " " : "")}{teamPrefix}{nameColor}{player.PlayerName}{ChatColors.Default}: {message}";

        if (teamOnly)
        {
            foreach (var receiver in Utilities.GetPlayers())
                if (receiver is { IsValid: true, IsBot: false } && receiver.Team == player.Team)
                    receiver.PrintToChat(line);
        }
        else Server.PrintToChatAll(line);
        return HookResult.Handled;
    }

    private static bool IsChatTrigger(string message)
    {
        var t = message.TrimStart();
        if (t.Length == 0) return false;
        foreach (var tr in CoreConfig.PublicChatTrigger) if (!string.IsNullOrEmpty(tr) && t.StartsWith(tr, StringComparison.Ordinal)) return true;
        foreach (var tr in CoreConfig.SilentChatTrigger) if (!string.IsNullOrEmpty(tr) && t.StartsWith(tr, StringComparison.Ordinal)) return true;
        return false;
    }

    // --- тег в таблице счёта ---
    private void ApplyScoreboard(CCSPlayerController player)
    {
        if (player is not { IsValid: true } || player.IsBot || player.IsHLTV) return;
        var want = StyleOf(player)?.ScoreTag ?? "";
        var had = _appliedClan.TryGetValue(player.SteamID, out var prev) ? prev : null;
        if (want.Length == 0 && had == null) return; // никогда не трогали — оставляем как есть
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
        if (style == null) return;
        if (isSmoke) ApplySmoke(new CSmokeGrenadeProjectile(g.Handle), style.Smoke);
        if (style.Trail.Length > 0 && TryColor(style.Trail, out var col)) StartTrail(g, col);
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
