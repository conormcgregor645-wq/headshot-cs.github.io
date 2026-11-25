// Длинная карта и серии убийств.
//  • Карта не заканчивается на 13 победах: играем без смены сторон, пока одна из команд не наберёт WinScore (100) побед.
//    Тогда объявляем победителя и перезапускаем счёт с нуля на той же карте (mp_restartgame).
//  • Серии убийств: убийства за раунд, пока игрок жив (пауза между ними не важна) —
//    DOUBLE KILL, TRIPLE KILL, MEGA KILL, RAMPAGE (как в паке озвучки). Надпись — цветной текст посреди экрана убившего
//    без серой плашки (point_worldtext перед глазами, видят только он и те, кто за ним наблюдает), и голос серии.
//    В чат ничего не пишется. Первая кровь раунда — тоже надпись и голос.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using Vector = CounterStrikeSharp.API.Modules.Utils.Vector;

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
        RegisterListener<Listeners.CheckTransmit>(StreakTransmit);
        RegisterListener<Listeners.OnMapStart>(_ => _streakText.Clear());
        RegisterListener<Listeners.OnTick>(StreakTextTick);
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
        // серия игрока сбрасывается, только когда он умирает или начинается новый раунд — пауза между убийствами не важна
        if (v is { IsValid: true }) _streak.Remove(v.SteamID == 0 ? (ulong)v.Slot : v.SteamID);
        if (a is not { IsValid: true } || v is not { IsValid: true } || a == v || a.TeamNum == v.TeamNum) return HookResult.Continue;
        if (Rules() is { WarmupPeriod: true }) return HookResult.Continue;
        var now = Server.CurrentTime;

        if (!_firstBlood)
        {
            _firstBlood = true; // первая кровь — первое убийство раунда на всём сервере, слышат все
            if (!a.IsBot) { Announce(a, "FIRST BLOOD", "#ff8a3d"); PlayTo(a, "first", true); }
        }

        var key0 = a.SteamID == 0 ? (ulong)a.Slot : a.SteamID;
        var n = (_streak.TryGetValue(key0, out var s) ? s.n : 0) + 1;
        _streak[key0] = (n, now);
        if (n < 2 || a.IsBot) return HookResult.Continue;
        var (text, color, key) = StreakNames[Math.Min(n, StreakNames.Length - 1)];
        Announce(a, text, color);
        PlayTo(a, key, true);
        return HookResult.Continue;
    }

    // --- надпись серии посреди экрана: point_worldtext в нескольких юнитах перед глазами, прикреплён к игроку ---
    private readonly Dictionary<int, CPointWorldText> _streakText = new(); // слот игрока → его надпись

    private void Announce(CCSPlayerController p, string text, string color)
    {
        try { ShowScreenText(p, text, color); }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] надпись серии: {Error}", ex.Message); }
    }

    private void ShowScreenText(CCSPlayerController p, string text, string color)
    {
        if (p.PlayerPawn.Value is not { IsValid: true } pawn || !p.PawnIsAlive || pawn.AbsOrigin is null) return;
        RemoveStreakText(p.Slot);
        if (!TryHex(color, out var c)) c = System.Drawing.Color.White;

        var ent = Utilities.CreateEntityByName<CPointWorldText>("point_worldtext");
        if (ent is null) return;
        ent.MessageText = text;
        ent.Enabled = true;
        ent.Fullbright = true;
        ent.FontName = "Arial Black";
        ent.FontSize = 64;
        ent.WorldUnitsPerPx = 0.0075f;
        ent.Color = c;
        ent.DrawBackground = false;
        ent.DepthOffset = 0f;
        ent.JustifyHorizontal = PointWorldTextJustifyHorizontal_t.POINT_WORLD_TEXT_JUSTIFY_HORIZONTAL_CENTER;
        ent.JustifyVertical = PointWorldTextJustifyVertical_t.POINT_WORLD_TEXT_JUSTIFY_VERTICAL_CENTER;
        ent.ReorientMode = PointWorldTextReorientMode_t.POINT_WORLD_TEXT_REORIENT_NONE;
        ent.DispatchSpawn();

        // ставим перед глазами и прикрепляем к игроку: движение сглаживает сама игра, а поворот взгляда догоняем каждый тик
        PlaceText(ent, pawn);
        ent.AcceptInput("SetParent", pawn, null, "!activator");

        _streakText[p.Slot] = ent;
        var slot = p.Slot;
        AddTimer(1.6f, () => { if (_streakText.TryGetValue(slot, out var e) && e == ent) RemoveStreakText(slot); }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static void PlaceText(CPointWorldText ent, CCSPlayerPawn pawn)
    {
        if (pawn.AbsOrigin is not { } o) return;
        var ang = pawn.EyeAngles;
        double pr = ang.X * Math.PI / 180, yr = ang.Y * Math.PI / 180;
        float cp = (float)Math.Cos(pr), sp = (float)Math.Sin(pr), cy = (float)Math.Cos(yr), sy = (float)Math.Sin(yr);
        float ex = o.X, ey = o.Y, ez = o.Z + pawn.ViewOffset.Z;
        const float dist = 9f, lift = 1.6f; // чуть выше прицела, чтобы не закрывать его
        var pos = new Vector(ex + cp * cy * dist + sp * cy * lift, ey + cp * sy * dist + sp * sy * lift, ez - sp * dist + cp * lift);
        ent.Teleport(pos, new QAngle(0, ang.Y + 270, 90 - ang.X), new Vector(0, 0, 0));
    }

    private void StreakTextTick()
    {
        if (_streakText.Count == 0) return;
        foreach (var (slot, ent) in _streakText.ToList())
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            if (!ent.IsValid || p is not { IsValid: true, PawnIsAlive: true } || p.PlayerPawn.Value is not { IsValid: true } pawn) { RemoveStreakText(slot); continue; }
            PlaceText(ent, pawn);
        }
    }

    private void RemoveStreakText(int slot)
    {
        if (_streakText.Remove(slot, out var e) && e.IsValid) e.Remove();
    }

    private static bool TryHex(string hex, out System.Drawing.Color c)
    {
        c = default;
        hex = hex.TrimStart('#');
        if (hex.Length != 6 || !int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var v)) return false;
        c = System.Drawing.Color.FromArgb(255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
        return true;
    }

    // надпись получает только её владелец и мёртвые/зрители, которые наблюдают за ним
    private void StreakTransmit(CCheckTransmitInfoList infoList)
    {
        if (_streakText.Count == 0) return;
        foreach (var (info, viewer) in infoList)
        {
            if (viewer is not { IsValid: true }) continue;
            var target = viewer.PawnIsAlive ? null
                : viewer.PlayerPawn.Value?.ObserverServices?.ObserverTarget.Value ?? viewer.ObserverPawn.Value?.ObserverServices?.ObserverTarget.Value;
            foreach (var (slot, ent) in _streakText)
            {
                if (!ent.IsValid || slot == viewer.Slot) continue;
                var owner = Utilities.GetPlayerFromSlot(slot);
                if (target is { IsValid: true } && owner?.PlayerPawn.Value is { IsValid: true } op && op.Handle == target.Handle) continue;
                info.TransmitEntities.Remove(ent);
            }
        }
    }

    // голос (если аддон с озвучкой подключён) или встроенный звук; everyone — слышат все игроки на сервере
    private void PlayTo(CCSPlayerController p, string key, bool everyone = false)
    {
        var map = Config.VoiceEnabled ? Config.VoiceSounds : Config.StreakSounds;
        if (!map.TryGetValue(key, out var snd) || !IsSafeSound(snd)) return;
        if (!everyone) { p.ExecuteClientCommand($"play {snd}"); return; }
        foreach (var x in Utilities.GetPlayers())
            if (x is { IsValid: true, IsBot: false, IsHLTV: false }) x.ExecuteClientCommand($"play {snd}");
    }
}
