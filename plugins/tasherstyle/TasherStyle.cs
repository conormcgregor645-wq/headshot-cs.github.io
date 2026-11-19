// TASHER Style: тег и цвет ника в чате, тег в таблице счёта и цвет дыма — по данным с сайта tashercs.ru.
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
}

public record PlayerStyle(string ChatTag, string NameColor, string ScoreTag, string Smoke);

public class TasherStyle : BasePlugin, IPluginConfig<StyleConfig>
{
    public override string ModuleName => "TASHER Style";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "tashercs.ru";

    public StyleConfig Config { get; set; } = new();
    private volatile Dictionary<ulong, PlayerStyle> _styles = new();
    private readonly ConcurrentDictionary<ulong, string> _appliedClan = new();
    private int _loading;

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
                    smoke VARCHAR(16) NOT NULL DEFAULT ''
                ) DEFAULT CHARSET=utf8mb4";
                await cmd.ExecuteNonQueryAsync();
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

    private void ReloadAsync()
    {
        if (Interlocked.Exchange(ref _loading, 1) == 1) return;
        Task.Run(async () =>
        {
            try
            {
                var map = new Dictionary<ulong, PlayerStyle>();
                await using var c = new MySqlConnection(ConnString);
                await c.OpenAsync();
                await using var cmd = c.CreateCommand();
                cmd.CommandText = "SELECT steamid, chat_tag, name_color, score_tag, smoke FROM tasher_style";
                await using var r = await cmd.ExecuteReaderAsync();
                while (await r.ReadAsync())
                    map[r.GetUInt64(0)] = new PlayerStyle(r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4));
                _styles = map;
                Server.NextFrame(() =>
                {
                    foreach (var p in Utilities.GetPlayers()) ApplyScoreboard(p);
                });
            }
            catch (Exception e) { Logger.LogError("[TASHER Style] не удалось прочитать стили: {Error}", e.Message); }
            finally { Interlocked.Exchange(ref _loading, 0); }
        });
    }

    private PlayerStyle? StyleOf(CCSPlayerController p) => _styles.TryGetValue(p.SteamID, out var s) ? s : null;

    // --- чат ---
    private HookResult HandleChat(CCSPlayerController? player, CommandInfo info, bool teamOnly)
    {
        if (player is not { IsValid: true } || player.IsBot || player.IsHLTV) return HookResult.Continue;
        var message = info.GetArg(1);
        if (string.IsNullOrWhiteSpace(message) || IsChatTrigger(message)) return HookResult.Continue;
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

    // --- цвет дыма ---
    private void OnEntitySpawned(CEntityInstance entity)
    {
        if (entity.DesignerName != "smokegrenade_projectile") return;
        var g = new CSmokeGrenadeProjectile(entity.Handle);
        if (g.Handle == IntPtr.Zero) return;
        Server.NextFrame(() => ApplySmoke(g, 0));
    }

    private void ApplySmoke(CSmokeGrenadeProjectile g, int attempt)
    {
        if (!g.IsValid) return;
        CCSPlayerPawn? pawn = g.Thrower.Value;
        if (pawn is null && g.OwnerEntity.Value is { IsValid: true } owner) pawn = new CCSPlayerPawn(owner.Handle);
        var bc = pawn is { IsValid: true } ? pawn.Controller.Value : null;
        if (bc is null || !bc.IsValid)
        {
            if (attempt < 8) Server.NextFrame(() => ApplySmoke(g, attempt + 1));
            return;
        }
        var controller = new CCSPlayerController(bc.Handle);
        var smoke = (controller.IsValid ? StyleOf(controller)?.Smoke : null) ?? "";
        if (smoke.Length == 0) return;

        float r, gr, b;
        if (smoke == "random")
        {
            r = Random.Shared.NextSingle() * 255f; gr = Random.Shared.NextSingle() * 255f; b = Random.Shared.NextSingle() * 255f;
        }
        else
        {
            var parts = smoke.Split(',');
            if (parts.Length != 3 || !float.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out r) || !float.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out gr) || !float.TryParse(parts[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out b)) return;
        }
        g.SmokeColor.X = r; g.SmokeColor.Y = gr; g.SmokeColor.Z = b;
        Utilities.SetStateChanged(g, "CSmokeGrenadeProjectile", "m_vSmokeColor");
    }
}
