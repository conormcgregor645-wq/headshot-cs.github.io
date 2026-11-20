// Мут (запрет голоса) и гег (запрет чата), выданные с сайта. Сайт пишет действующие наказания в tasher_punish,
// плагин применяет их сразу после записи (RCON css_tasher_style_reload) и сам снимает, когда срок вышел.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using MySqlConnector;

namespace TasherStyle;

// until: -1 — наказания нет, 0 — навсегда, иначе unix-секунды окончания
public record Sanction(long MuteUntil, string MuteReason, long GagUntil, string GagReason);

public partial class TasherStyle
{
    private volatile Dictionary<ulong, Sanction> _punish = new();
    private volatile bool _punishLoaded;
    private readonly HashSet<ulong> _mutedByUs = new();
    private readonly Dictionary<ulong, DateTime> _gagNotice = new();

    private void LoadPunish()
    {
        // срок мог выйти между перечитываниями — проверяем голос раз в 5 секунд
        AddTimer(5f, ApplyVoiceAll, TimerFlags.REPEAT);
        RegisterEventHandler<EventPlayerConnectFull>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true, IsBot: false, IsHLTV: false })
            {
                var sid = p.SteamID;
                Server.NextFrame(() => ApplyVoice(p));
                AddTimer(4f, () =>
                {
                    var x = Utilities.GetPlayers().FirstOrDefault(y => y is { IsValid: true, IsBot: false } && y.SteamID == sid);
                    if (x != null) TellSanctions(x, true, true);
                });
            }
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDisconnect>((e, _) =>
        {
            if (e.Userid is { } p) { _mutedByUs.Remove(p.SteamID); _gagNotice.Remove(p.SteamID); }
            return HookResult.Continue;
        });
    }

    private static async Task CreatePunishTableAsync(MySqlConnection c)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = @"CREATE TABLE IF NOT EXISTS tasher_punish (
                steamid BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                mute_until BIGINT NOT NULL DEFAULT -1,
                mute_reason VARCHAR(128) NOT NULL DEFAULT '',
                gag_until BIGINT NOT NULL DEFAULT -1,
                gag_reason VARCHAR(128) NOT NULL DEFAULT ''
            ) DEFAULT CHARSET=utf8mb4";
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task LoadPunishAsync(MySqlConnection c)
    {
        var map = new Dictionary<ulong, Sanction>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT steamid, mute_until, mute_reason, gag_until, gag_reason FROM tasher_punish";
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                map[r.GetUInt64(0)] = new Sanction(r.GetInt64(1), r.GetString(2), r.GetInt64(3), r.GetString(4));
        }
        var old = _punish;
        var first = !_punishLoaded;
        _punish = map; _punishLoaded = true;
        Server.NextFrame(() =>
        {
            ApplyVoiceAll();
            if (first) return;
            // новым наказанным, кто сейчас на сервере, — сразу сообщение
            foreach (var p in Utilities.GetPlayers())
            {
                if (p is not { IsValid: true, IsBot: false, IsHLTV: false }) continue;
                old.TryGetValue(p.SteamID, out var a);
                map.TryGetValue(p.SteamID, out var b);
                var newMute = IsActive(b?.MuteUntil) && !IsActive(a?.MuteUntil);
                var newGag = IsActive(b?.GagUntil) && !IsActive(a?.GagUntil);
                if (newMute || newGag) TellSanctions(p, newMute, newGag);
                if (IsActive(a?.MuteUntil) && !IsActive(b?.MuteUntil)) p.PrintToChat($"{Prefix}{ChatColors.Lime}Мут снят{ChatColors.Default} — микрофон снова работает.");
                if (IsActive(a?.GagUntil) && !IsActive(b?.GagUntil)) p.PrintToChat($"{Prefix}{ChatColors.Lime}Гег снят{ChatColors.Default} — можно писать в чат.");
            }
        });
    }

    private static bool IsActive(long? until) =>
        until is { } u && u != -1 && (u == 0 || u > DateTimeOffset.UtcNow.ToUnixTimeSeconds());

    private static string UntilText(long until) =>
        until == 0 ? "навсегда" : "до " + DateTimeOffset.FromUnixTimeSeconds(until).ToOffset(TimeSpan.FromHours(3)).ToString("dd.MM HH:mm") + " МСК";

    private Sanction? SanctionOf(ulong sid) => _punish.TryGetValue(sid, out var s) ? s : null;
    private bool IsGagged(CCSPlayerController p) => IsActive(SanctionOf(p.SteamID)?.GagUntil);

    private void TellSanctions(CCSPlayerController p, bool mute, bool gag)
    {
        var s = SanctionOf(p.SteamID);
        if (s == null) return;
        if (mute && IsActive(s.MuteUntil))
            p.PrintToChat($"{Prefix}{ChatColors.Red}Мут{ChatColors.Default} (без микрофона) {UntilText(s.MuteUntil)}. Причина: {s.MuteReason}");
        if (gag && IsActive(s.GagUntil))
            p.PrintToChat($"{Prefix}{ChatColors.Red}Гег{ChatColors.Default} (без чата) {UntilText(s.GagUntil)}. Причина: {s.GagReason}");
    }

    private void ApplyVoiceAll()
    {
        foreach (var p in Utilities.GetPlayers()) ApplyVoice(p);
    }

    private void ApplyVoice(CCSPlayerController p)
    {
        if (p is not { IsValid: true, IsBot: false, IsHLTV: false }) return;
        var sid = p.SteamID;
        var muted = IsActive(SanctionOf(sid)?.MuteUntil);
        if (muted)
        {
            if (!p.VoiceFlags.HasFlag(VoiceFlags.Muted)) p.VoiceFlags |= VoiceFlags.Muted;
            _mutedByUs.Add(sid);
        }
        else if (_mutedByUs.Remove(sid))
        {
            p.VoiceFlags &= ~VoiceFlags.Muted;
        }
    }

    // чат игрока с гегом: обычные сообщения не проходят, команды через / (тихие) работают
    private bool BlockGagged(CCSPlayerController player, string message)
    {
        if (!IsGagged(player)) return false;
        if (message.TrimStart().StartsWith('/')) return false;
        var now = DateTime.UtcNow;
        if (!_gagNotice.TryGetValue(player.SteamID, out var last) || (now - last).TotalSeconds > 3)
        {
            _gagNotice[player.SteamID] = now;
            var s = SanctionOf(player.SteamID)!;
            player.PrintToChat($"{Prefix}{ChatColors.Red}Чат закрыт{ChatColors.Default}: гег {UntilText(s.GagUntil)}. Причина: {s.GagReason}");
            player.PrintToChat($"{Prefix}Команды можно писать через /, например {ChatColors.Lime}/rank");
        }
        return true;
    }
}
