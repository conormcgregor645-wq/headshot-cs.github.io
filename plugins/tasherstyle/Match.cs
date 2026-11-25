// Длинная карта и серии убийств.
//  • Карта не заканчивается на 13 победах: играем без смены сторон, пока одна из команд не наберёт WinScore (100) побед.
//    Тогда объявляем победителя и перезапускаем счёт с нуля на той же карте (mp_restartgame).
//  • Серии убийств: несколько убийств подряд с паузой не больше StreakWindow секунд —
//    DOUBLE KILL, TRIPLE KILL, MEGA KILL, RAMPAGE (как в паке озвучки). Надпись по центру экрана у убившего, звук из игры,
//    с тройной серии — строка в чат всем. Первая кровь раунда — тоже надпись и звук.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace TasherStyle;

public partial class TasherStyle
{
    private readonly Dictionary<ulong, (int n, float at)> _streak = new();
    private bool _firstBlood;
    private bool _restarting;

    private void LoadMatch()
    {
        RegisterListener<Listeners.OnMapStart>(_ => { _streak.Clear(); _restarting = false; AddTimer(2f, ApplyMatchCvars, TimerFlags.STOP_ON_MAPCHANGE); });
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            _firstBlood = false; _streak.Clear();
            ApplyMatchCvars(); // конфиг режима мог вернуть обычные значения при смене карты
            return HookResult.Continue;
        });
        RegisterEventHandler<EventRoundEnd>(MatchRoundEnd, HookMode.Post);
        RegisterEventHandler<EventPlayerDeath>(StreakDeath);
        AddTimer(1f, ApplyMatchCvars);
    }

    private void ApplyMatchCvars()
    {
        // голос: обе команды слышат друг друга; мёртвые слышат всех, а живые мёртвых — нет
        if (Config.AllTalk) Server.ExecuteCommand("sv_alltalk 1; sv_deadtalk 0; sv_full_alltalk 0; sv_talk_enemy_living 1; sv_talk_enemy_dead 1");
        if (Config.WinScore <= 0) return;
        // запас по раундам больше, чем нужно до WinScore; «досрочной победы» и смены сторон нет
        Server.ExecuteCommand($"mp_maxrounds {Config.WinScore * 2 + 1}; mp_halftime 0; mp_match_can_clinch 0; mp_overtime_enable 0");
    }

    private HookResult MatchRoundEnd(EventRoundEnd e, GameEventInfo info)
    {
        if (Config.WinScore <= 0 || _restarting) return HookResult.Continue;
        int ct = 0, t = 0;
        foreach (var tm in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
        {
            if (tm.TeamNum == 3) ct = tm.Score;
            else if (tm.TeamNum == 2) t = tm.Score;
        }
        if (Math.Max(ct, t) < Config.WinScore) return HookResult.Continue;
        _restarting = true;
        var who = ct >= t ? $"{ChatColors.LightBlue}Спецназ" : $"{ChatColors.Yellow}Террористы";
        Server.PrintToChatAll($"{Prefix}{who}{ChatColors.Default} набрали {ChatColors.Lime}{Config.WinScore}{ChatColors.Default} побед ({ct}:{t})! Счёт обнуляется — играем дальше.");
        AddTimer(4f, () => { Server.ExecuteCommand("mp_restartgame 1"); AddTimer(3f, () => _restarting = false, TimerFlags.STOP_ON_MAPCHANGE); }, TimerFlags.STOP_ON_MAPCHANGE);
        return HookResult.Continue;
    }

    private static readonly (string Text, string Color, string Key)[] StreakNames =
    {
        ("", "", ""), ("", "", ""),
        ("DOUBLE KILL", "#b5e853", "2"),
        ("TRIPLE KILL", "#38d3ff", "3"),
        ("MEGA KILL", "#d32ce6", "4"),
        ("RAMPAGE", "#ff4d4d", "5"),
    };

    private HookResult StreakDeath(EventPlayerDeath e, GameEventInfo info)
    {
        if (!Config.StreaksEnabled) return HookResult.Continue;
        var a = e.Attacker; var v = e.Userid;
        if (a is not { IsValid: true } || v is not { IsValid: true } || a == v || a.TeamNum == v.TeamNum) return HookResult.Continue;
        if (Rules() is { WarmupPeriod: true }) return HookResult.Continue;
        var now = Server.CurrentTime;

        if (!_firstBlood)
        {
            _firstBlood = true;
            if (!a.IsBot) { Announce(a, "FIRST BLOOD", "#ff8a3d"); PlayTo(a, "first"); }
        }

        var n = _streak.TryGetValue(a.SteamID == 0 ? (ulong)a.Slot : a.SteamID, out var s) && now - s.at <= Config.StreakWindow ? s.n + 1 : 1;
        _streak[a.SteamID == 0 ? (ulong)a.Slot : a.SteamID] = (n, now);
        if (n < 2 || a.IsBot) return HookResult.Continue;
        var (text, color, key) = StreakNames[Math.Min(n, StreakNames.Length - 1)];
        Announce(a, text, color);
        PlayTo(a, key, n >= 3);
        if (n >= 3) Server.PrintToChatAll($"{Prefix}{ChatColors.Lime}{a.PlayerName}{ChatColors.Default} — {ChatColors.Red}{text}{ChatColors.Default}!");
        return HookResult.Continue;
    }

    private static void Announce(CCSPlayerController p, string text, string color) =>
        p.PrintToCenterHtml($"<font class='fontSize-xl fontWeight-Bold' color='{color}'>{text}</font>", 2);

    // голос (если аддон с озвучкой подключён) или встроенный звук; everyone — серию от тройной слышат все
    private void PlayTo(CCSPlayerController p, string key, bool everyone = false)
    {
        var map = Config.VoiceEnabled ? Config.VoiceSounds : Config.StreakSounds;
        if (!map.TryGetValue(key, out var snd) || !IsSafeSound(snd)) return;
        if (!everyone || !Config.VoiceEnabled) { p.ExecuteClientCommand($"play {snd}"); return; }
        foreach (var x in Utilities.GetPlayers())
            if (x is { IsValid: true, IsBot: false, IsHLTV: false }) x.ExecuteClientCommand($"play {snd}");
    }
}
