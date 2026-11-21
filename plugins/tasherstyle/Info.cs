// Команды в игре (!rank, !top, !tk, !quests), сообщения о выполненных заданиях и приветствие игроков со статусом.
// Данные готовит сайт: таблицы tasher_player (кто на сервере и у кого статус) и tasher_top (топ-10 месяца).
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using MySqlConnector;

namespace TasherStyle;

public class QuestItem
{
    [JsonPropertyName("n")] public string N { get; set; } = "";
    [JsonPropertyName("h")] public int H { get; set; }
    [JsonPropertyName("g")] public int G { get; set; }
    [JsonPropertyName("r")] public int R { get; set; }
    [JsonPropertyName("d")] public int D { get; set; }
}

public class QuestDay
{
    [JsonPropertyName("l")] public List<QuestItem> L { get; set; } = new();
    [JsonPropertyName("b")] public int B { get; set; }
    [JsonPropertyName("bt")] public int Bt { get; set; }
}

public class PassInfo
{
    [JsonPropertyName("s")] public string S { get; set; } = "";
    [JsonPropertyName("lv")] public int Lv { get; set; }
    [JsonPropertyName("xp")] public int Xp { get; set; }
    [JsonPropertyName("need")] public int Need { get; set; }
    [JsonPropertyName("max")] public int Max { get; set; }
    [JsonPropertyName("prem")] public int Prem { get; set; }
    [JsonPropertyName("un")] public int Un { get; set; }
    [JsonPropertyName("to")] public long To { get; set; }
}

public record PlayerInfo(string Name, string Tier, int Place, int Pts, int Kills, int Deaths, int Hs,
    long Tk, int TkPending, int EarnToday, int EarnCap, string EarnMult, QuestDay? Quests,
    string League = "", int Sr = 0, string LeagueInfo = "", string Pass = "");

public record TopRow(int Place, string Name, int Pts, int Kills, int Deaths);

public partial class TasherStyle
{
    private volatile Dictionary<ulong, PlayerInfo> _info = new();
    private volatile List<TopRow> _top = new();
    private volatile bool _infoLoaded;
    private volatile bool _infoExt; // в tasher_player есть колонки лиги и пропуска (1.3)
    private readonly ConcurrentDictionary<ulong, DateTime> _greeted = new();
    private DateTime _lastGreetSound = DateTime.MinValue;

    private static readonly Dictionary<string, string> TierColor = new()
    {
        ["VIP"] = "silver", ["PREMIUM"] = "lightblue", ["ELITE"] = "green", ["LEGEND"] = "purple", ["TITAN"] = "orange", ["KING"] = "gold",
    };

    private string Prefix => $" {ChatColors.Green}[TASHER]{ChatColors.Default} ";

    private void LoadInfo()
    {
        RegisterEventHandler<EventPlayerConnectFull>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true, IsBot: false, IsHLTV: false })
            {
                var sid = p.SteamID;
                AddTimer(3f, () => { Welcome(sid); ApplyPremierRanking(p); });
            }
            return HookResult.Continue;
        });
    }

    private async Task CreateInfoTablesAsync(MySqlConnection c)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = @"CREATE TABLE IF NOT EXISTS tasher_player (
                steamid BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                name VARCHAR(64) NOT NULL DEFAULT '',
                tier VARCHAR(16) NOT NULL DEFAULT '',
                place INT NOT NULL DEFAULT 0,
                pts INT NOT NULL DEFAULT 0,
                kills INT NOT NULL DEFAULT 0,
                deaths INT NOT NULL DEFAULT 0,
                hs INT NOT NULL DEFAULT 0,
                tk BIGINT NOT NULL DEFAULT -1,
                tk_pending INT NOT NULL DEFAULT 0,
                earn_today INT NOT NULL DEFAULT 0,
                earn_cap INT NOT NULL DEFAULT 0,
                earn_mult VARCHAR(8) NOT NULL DEFAULT '1',
                quests TEXT
            ) DEFAULT CHARSET=utf8mb4";
        await cmd.ExecuteNonQueryAsync();
        await using var cmd2 = c.CreateCommand();
        cmd2.CommandText = @"CREATE TABLE IF NOT EXISTS tasher_top (
                place INT NOT NULL PRIMARY KEY,
                steamid BIGINT UNSIGNED NOT NULL,
                name VARCHAR(64) NOT NULL DEFAULT '',
                pts INT NOT NULL DEFAULT 0,
                kills INT NOT NULL DEFAULT 0,
                deaths INT NOT NULL DEFAULT 0
            ) DEFAULT CHARSET=utf8mb4";
        await cmd2.ExecuteNonQueryAsync();
        // колонки 1.3: лига и боевой пропуск
        var ok = true;
        foreach (var (col, def) in new[] { ("league", "VARCHAR(16) NOT NULL DEFAULT ''"), ("sr", "INT NOT NULL DEFAULT 0"), ("league_info", "VARCHAR(160) NOT NULL DEFAULT ''"), ("pass", "TEXT") })
        {
            await using var chk = c.CreateCommand();
            chk.CommandText = "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_player' AND COLUMN_NAME=@c";
            chk.Parameters.AddWithValue("@c", col);
            if (Convert.ToInt64(await chk.ExecuteScalarAsync()) > 0) continue;
            try
            {
                await using var alter = c.CreateCommand();
                alter.CommandText = $"ALTER TABLE tasher_player ADD COLUMN `{col}` {def}";
                await alter.ExecuteNonQueryAsync();
            }
            catch (Exception e) { ok = false; Logger.LogError("[TASHER Style] не удалось добавить колонку {Col}: {Error}", col, e.Message); }
        }
        _infoExt = ok;
    }

    private async Task LoadInfoAsync(MySqlConnection c)
    {
        var map = new Dictionary<ulong, PlayerInfo>();
        await using (var cmd = c.CreateCommand())
        {
            var ext = _infoExt;
            cmd.CommandText = "SELECT steamid, name, tier, place, pts, kills, deaths, hs, tk, tk_pending, earn_today, earn_cap, earn_mult, quests" + (ext ? ", league, sr, league_info, pass" : "") + " FROM tasher_player";
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
            {
                QuestDay? q = null;
                if (!r.IsDBNull(13))
                {
                    var js = r.GetString(13);
                    if (js.Length > 0) { try { q = JsonSerializer.Deserialize<QuestDay>(js); } catch { q = null; } }
                }
                map[r.GetUInt64(0)] = new PlayerInfo(r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetInt32(4), r.GetInt32(5), r.GetInt32(6), r.GetInt32(7),
                    r.GetInt64(8), r.GetInt32(9), r.GetInt32(10), r.GetInt32(11), r.GetString(12), q,
                    ext ? r.GetString(14) : "", ext ? r.GetInt32(15) : 0, ext ? r.GetString(16) : "", ext && !r.IsDBNull(17) ? r.GetString(17) : "");
            }
        }
        var top = new List<TopRow>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT place, name, pts, kills, deaths FROM tasher_top ORDER BY place LIMIT 10";
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) top.Add(new TopRow(r.GetInt32(0), r.GetString(1), r.GetInt32(2), r.GetInt32(3), r.GetInt32(4)));
        }
        var old = _info;
        var first = !_infoLoaded;
        _info = map; _top = top; _infoLoaded = true;
        // Сайт обновляет месячные очки; применяем в штатное поле Premier на главном потоке.
        Server.NextFrame(() =>
        {
            foreach (var player in Utilities.GetPlayers()) ApplyPremierRanking(player);
            if (!first) NotifyQuests(old, map);
        });
    }

    private PlayerInfo? InfoOf(CCSPlayerController p) => _info.TryGetValue(p.SteamID, out var i) ? i : null;

    private static PassInfo? PassOf(PlayerInfo? i)
    {
        if (i == null || i.Pass.Length == 0) return null;
        try { return JsonSerializer.Deserialize<PassInfo>(i.Pass); } catch { return null; }
    }

    // --- выполненные задания: сообщаем игроку сразу, как сайт засчитал ---
    private void NotifyQuests(Dictionary<ulong, PlayerInfo> before, Dictionary<ulong, PlayerInfo> after)
    {
        foreach (var p in Utilities.GetPlayers())
        {
            if (p is not { IsValid: true, IsBot: false, IsHLTV: false }) continue;
            if (!before.TryGetValue(p.SteamID, out var a) || !after.TryGetValue(p.SteamID, out var b)) continue;
            // новый уровень боевого пропуска
            var pa = PassOf(a); var pb = PassOf(b);
            if (pa != null && pb != null && pa.S == pb.S && pb.Lv > pa.Lv)
                p.PrintToChat($"{Prefix}{ChatColors.Gold}Новый уровень пропуска: {pb.Lv}!{ChatColors.Default} Награда ждёт на {ChatColors.Lime}{Config.Site}");
            if (a.Quests is not { } qa || b.Quests is not { } qb || qa.L.Count != qb.L.Count) continue;
            // другой день — другие задания, ничего не сравниваем
            var sameDay = true;
            for (var i = 0; i < qa.L.Count; i++) if (qa.L[i].N != qb.L[i].N) { sameDay = false; break; }
            if (!sameDay) continue;
            for (var i = 0; i < qb.L.Count; i++)
                if (qa.L[i].D == 0 && qb.L[i].D == 1)
                    p.PrintToChat($"{Prefix}{ChatColors.Lime}Задание выполнено:{ChatColors.Default} {qb.L[i].N} — {ChatColors.Gold}+{qb.L[i].R} ТК");
            if (qa.B == 0 && qb.B == 1)
                p.PrintToChat($"{Prefix}{ChatColors.Gold}Все задания дня выполнены!{ChatColors.Default} Бонус {ChatColors.Gold}+{qb.Bt} ТК");
        }
    }

    // --- приветствие при входе ---
    private void Welcome(ulong sid)
    {
        var p = Utilities.GetPlayers().FirstOrDefault(x => x is { IsValid: true, IsBot: false } && x.SteamID == sid);
        if (p == null) return;
        p.PrintToChat($"{Prefix}Команды: {ChatColors.Lime}!rank !top !tk !quests !pass{ChatColors.Default} — рейтинг, баланс, задания и пропуск");
        var info = InfoOf(p);
        if (info == null || info.Tier.Length == 0) return;
        var now = DateTime.UtcNow;
        if (_greeted.TryGetValue(sid, out var last) && (now - last).TotalMinutes < Math.Max(0, Config.GreetCooldownMinutes)) return;
        _greeted[sid] = now;
        var col = TagColors.ColorChar(TierColor.GetValueOrDefault(info.Tier, "default"), p.Team);
        Server.PrintToChatAll($" {col}[{info.Tier}] {p.PlayerName}{ChatColors.Default} заходит на сервер!");
        // UPD: вход игрока сопровождается сообщением, без дополнительного звука.
        // В игре слышны только приобретённые звуки убийства.
    }

    // --- команды ---
    private bool InfoReady(CCSPlayerController p, out PlayerInfo info)
    {
        info = InfoOf(p)!;
        if (info != null) return true;
        p.PrintToChat($"{Prefix}Данные ещё обновляются — попробуй через минуту.");
        return false;
    }

    private static char LeagueColor(string league) => league switch
    {
        "Железо" => ChatColors.Grey, "Бронза" => ChatColors.Orange, "Серебро" => ChatColors.Silver, "Золото" => ChatColors.Gold,
        "Платина" => ChatColors.LightBlue, "Алмаз" => ChatColors.Blue, "Мастер" => ChatColors.Purple, "Легенда" => ChatColors.Red,
        _ => ChatColors.Default,
    };

    private static string Kd(int k, int d) => d == 0 ? k.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) : ((double)k / d).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);
    private static string Num(long v) => v.ToString("#,0", System.Globalization.CultureInfo.InvariantCulture).Replace(",", " ");

    [ConsoleCommand("css_rank", "Твоё место в рейтинге месяца")]
    public void OnRank(CCSPlayerController? player, CommandInfo cmd)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!InfoReady(player, out var i)) return;
        // UPD: лиги не показываем; !rank оставляем для очков, места и K/D месячного рейтинга.
        if (i.Place == 0)
        {
            player.PrintToChat($"{Prefix}В этом месяце у тебя пока нет очков рейтинга — сыграй пару раундов.");
            return;
        }
        player.PrintToChat($"{Prefix}Ты {ChatColors.Gold}#{i.Place}{ChatColors.Default} в рейтинге месяца · {ChatColors.Lime}{i.Pts}{ChatColors.Default} очков");
        player.PrintToChat($"{Prefix}Убийств {i.Kills}, смертей {i.Deaths}, K/D {Kd(i.Kills, i.Deaths)}, в голову {i.Hs}. Весь рейтинг: {Config.Site}");
    }

    [ConsoleCommand("css_top", "Топ-10 игроков месяца")]
    public void OnTop(CCSPlayerController? player, CommandInfo cmd)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        var top = _top;
        if (top.Count == 0) { player.PrintToChat($"{Prefix}В этом месяце рейтинг пока пуст."); return; }
        player.PrintToChat($"{Prefix}{ChatColors.Gold}Топ-10 месяца:");
        foreach (var t in top)
        {
            var c = t.Place switch { 1 => ChatColors.Gold, 2 => ChatColors.Silver, 3 => ChatColors.Orange, _ => ChatColors.Default };
            player.PrintToChat($" {c}{t.Place}. {t.Name}{ChatColors.Default} — {t.Pts} очк., K/D {Kd(t.Kills, t.Deaths)}");
        }
    }

    [ConsoleCommand("css_tk", "Твой баланс ТК")]
    public void OnTk(CCSPlayerController? player, CommandInfo cmd)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!InfoReady(player, out var i)) return;
        if (i.Tk < 0)
        {
            player.PrintToChat($"{Prefix}Ты ещё не заходил на {ChatColors.Lime}{Config.Site}{ChatColors.Default} — там тебя ждут {ChatColors.Gold}{Num(i.TkPending)} ТК{ChatColors.Default} за игру. Войди через Steam!");
            return;
        }
        var mult = i.EarnMult is "1" or "" ? "" : $" (×{i.EarnMult} за статус)";
        player.PrintToChat($"{Prefix}Баланс: {ChatColors.Gold}{Num(i.Tk + i.TkPending)} ТК{ChatColors.Default} · сегодня за игру {i.EarnToday}/{i.EarnCap}{mult}");
    }

    [ConsoleCommand("css_quests", "Задания дня")]
    public void OnQuests(CCSPlayerController? player, CommandInfo cmd)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!InfoReady(player, out var i)) return;
        if (i.Quests is not { L.Count: > 0 } q) { player.PrintToChat($"{Prefix}Задания дня появятся через минуту."); return; }
        player.PrintToChat($"{Prefix}{ChatColors.Gold}Задания дня{ChatColors.Default} (новые в 00:00 по Москве):");
        foreach (var x in q.L)
        {
            var state = x.D == 1 ? $"{ChatColors.Lime}выполнено" : $"{ChatColors.Yellow}{x.H}/{x.G}";
            player.PrintToChat($" {state}{ChatColors.Default} · {x.N} · {ChatColors.Gold}+{x.R} ТК");
        }
        player.PrintToChat(q.B == 1
            ? $" {ChatColors.Lime}Бонус за все три получен: +{q.Bt} ТК"
            : $" За все три задания — ещё {ChatColors.Gold}+{q.Bt} ТК");
    }

    [ConsoleCommand("css_pass", "Боевой пропуск")]
    public void OnPass(CCSPlayerController? player, CommandInfo cmd)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!InfoReady(player, out var i)) return;
        var ps = PassOf(i);
        if (ps == null) { player.PrintToChat($"{Prefix}Сейчас сезон боевого пропуска не идёт."); return; }
        var days = Math.Max(0, (int)((ps.To - DateTimeOffset.UtcNow.ToUnixTimeSeconds()) / 86400));
        player.PrintToChat($"{Prefix}{ChatColors.Gold}{ps.S}{ChatColors.Default}: уровень {ChatColors.Lime}{ps.Lv}/{ps.Max}{ChatColors.Default}" +
            (ps.Lv >= ps.Max ? " — максимум!" : $" · {ps.Xp}/{ps.Need} опыта до следующего"));
        player.PrintToChat($"{Prefix}{(ps.Prem == 1 ? $"{ChatColors.Gold}Премиум" : "Бесплатный")}{ChatColors.Default} · до конца сезона {days} дн." +
            (ps.Un > 0 ? $" · ждут наград: {ChatColors.Lime}{ps.Un}{ChatColors.Default} — забери на {Config.Site}" : ""));
    }

    [ConsoleCommand("css_daily", "Задания дня")]
    public void OnDaily(CCSPlayerController? player, CommandInfo cmd) => OnQuests(player, cmd);
}
