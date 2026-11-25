// Длинная карта и серии убийств.
//  • Карта не заканчивается на 13 победах: играем без смены сторон, пока одна из команд не наберёт WinScore (100) побед.
//    Тогда объявляем победителя и перезапускаем счёт с нуля на той же карте (mp_restartgame).
//  • Серии убийств: убийства за раунд, пока игрок жив (пауза между ними не важна) —
//    DOUBLE KILL, TRIPLE KILL, MEGA KILL, RAMPAGE (как в паке озвучки). Надпись — красный текст со стекающей кровью посреди экрана убившего
//    без серой плашки (point_worldtext перед глазами, видят только он и те, кто за ним наблюдает), и голос серии.
//    В чат ничего не пишется. Первое убийство игрока в раунде — его личная «первая кровь». Звуки слышит только сам игрок.
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
    private bool _restarting;

    private void LoadMatch()
    {
        RegisterListener<Listeners.OnMapStart>(_ => { _streak.Clear(); _restarting = false; AddTimer(2f, ApplyMatchCvars, TimerFlags.STOP_ON_MAPCHANGE); });
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            _streak.Clear();
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

        var key0 = a.SteamID == 0 ? (ulong)a.Slot : a.SteamID;
        var n = (_streak.TryGetValue(key0, out var s) ? s.n : 0) + 1;
        _streak[key0] = (n, now);
        if (a.IsBot) return HookResult.Continue;
        // первое убийство игрока в раунде — его личная «первая кровь»; дальше серия. Звук и надпись — только самому игроку
        if (n == 1) { Announce(a, "FIRST BLOOD", "#ff8a3d"); PlayTo(a, "first"); return HookResult.Continue; }
        var (text, color, key) = StreakNames[Math.Min(n, StreakNames.Length - 1)];
        Announce(a, text, color);
        PlayTo(a, key);
        return HookResult.Continue;
    }

    // --- надпись серии посреди экрана: красный point_worldtext перед глазами, прикреплён к игроку ---
    // Под буквами — несколько тёмно-красных капель, которые медленно стекают вниз, как кровь.
    private sealed class StreakFx
    {
        public CPointWorldText Main = null!;
        public readonly List<(CPointWorldText E, float X, float Speed, float Delay)> Drips = new();
        public float Born;
        public IEnumerable<CPointWorldText> All() { yield return Main; foreach (var d in Drips) yield return d.E; }
    }
    private readonly Dictionary<int, StreakFx> _streakText = new(); // слот игрока → его надпись
    private const string StreakRed = "#e3121b", BloodRed = "#7a0006";
    private const float TextDist = 9f, TextLift = 2.7f, TextLife = 2f;
    private const int TextFont = 64; private const float TextUnits = 0.0075f;

    private void Announce(CCSPlayerController p, string text, string color)
    {
        try { ShowScreenText(p, text); }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] надпись серии: {Error}", ex.Message); }
    }

    private static CPointWorldText? MakeText(string text, string hex, int size)
    {
        var ent = Utilities.CreateEntityByName<CPointWorldText>("point_worldtext");
        if (ent is null) return null;
        TryHex(hex, out var c);
        ent.MessageText = text;
        ent.Enabled = true;
        ent.Fullbright = true;
        ent.FontName = "Arial Black";
        ent.FontSize = size;
        ent.WorldUnitsPerPx = TextUnits;
        ent.Color = c;
        ent.DrawBackground = false;
        ent.DepthOffset = 0f;
        ent.JustifyHorizontal = PointWorldTextJustifyHorizontal_t.POINT_WORLD_TEXT_JUSTIFY_HORIZONTAL_CENTER;
        ent.JustifyVertical = PointWorldTextJustifyVertical_t.POINT_WORLD_TEXT_JUSTIFY_VERTICAL_TOP;
        ent.ReorientMode = PointWorldTextReorientMode_t.POINT_WORLD_TEXT_REORIENT_NONE;
        ent.DispatchSpawn();
        return ent;
    }

    private void ShowScreenText(CCSPlayerController p, string text)
    {
        if (p.PlayerPawn.Value is not { IsValid: true } pawn || !p.PawnIsAlive || pawn.AbsOrigin is null) return;
        RemoveStreakText(p.Slot);
        var main = MakeText(text, StreakRed, TextFont);
        if (main is null) return;
        var fx = new StreakFx { Main = main, Born = Server.CurrentTime };

        // капли: 4–5 штук под буквами (ширина надписи — примерно 0.78 высоты шрифта на букву), каждая со своей скоростью
        var half = text.Length * TextFont * 0.78f * TextUnits / 2f;
        var n = Math.Clamp(text.Length / 2, 3, 5);
        for (var i = 0; i < n; i++)
        {
            var slotX = -half + (i + 0.5f) * (2 * half / n) + (Random.Shared.NextSingle() - 0.5f) * (half / n);
            // не ставим каплю в пробел между словами
            var ci = (int)((slotX + half) / (2 * half) * text.Length);
            if (ci >= 0 && ci < text.Length && text[ci] == ' ') slotX += half / n * 0.6f;
            var d = MakeText("|", BloodRed, 34 + Random.Shared.Next(14));
            if (d is null) continue;
            fx.Drips.Add((d, slotX, 0.25f + Random.Shared.NextSingle() * 0.35f, Random.Shared.NextSingle() * 0.5f));
        }

        // ставим перед глазами и прикрепляем к игроку: движение сглаживает сама игра, а поворот взгляда догоняем каждый тик
        PlaceFx(fx, pawn, 0f);
        foreach (var e in fx.All()) e.AcceptInput("SetParent", pawn, null, "!activator");

        _streakText[p.Slot] = fx;
        var slot = p.Slot;
        AddTimer(TextLife, () => { if (_streakText.TryGetValue(slot, out var cur) && cur == fx) RemoveStreakText(slot); }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    // x — сдвиг вправо от центра, lift — высота над линией взгляда (в юнитах мира на расстоянии TextDist)
    private static void PlaceAt(CPointWorldText ent, CCSPlayerPawn pawn, float x, float lift)
    {
        if (pawn.AbsOrigin is not { } o) return;
        var ang = pawn.EyeAngles;
        double pr = ang.X * Math.PI / 180, yr = ang.Y * Math.PI / 180;
        float cp = (float)Math.Cos(pr), sp = (float)Math.Sin(pr), cy = (float)Math.Cos(yr), sy = (float)Math.Sin(yr);
        float ez = o.Z + pawn.ViewOffset.Z;
        // вперёд (cp*cy, cp*sy, -sp), вверх (sp*cy, sp*sy, cp), вправо (sy, -cy, 0)
        var pos = new Vector(
            o.X + cp * cy * TextDist + sp * cy * lift + sy * x,
            o.Y + cp * sy * TextDist + sp * sy * lift - cy * x,
            ez - sp * TextDist + cp * lift);
        ent.Teleport(pos, new QAngle(0, ang.Y + 270, 90 - ang.X), new Vector(0, 0, 0));
    }

    private static void PlaceFx(StreakFx fx, CCSPlayerPawn pawn, float age)
    {
        if (fx.Main.IsValid) PlaceAt(fx.Main, pawn, 0, TextLift);
        var textH = TextFont * TextUnits;
        foreach (var (e, x, speed, delay) in fx.Drips)
        {
            if (!e.IsValid) continue;
            var t = Math.Max(0f, age - delay);
            // капля начинается у нижнего края букв и стекает вниз, постепенно замедляясь
            var drop = speed * t / (1f + t * 0.6f);
            PlaceAt(e, pawn, x, TextLift - textH * 0.72f - drop);
        }
    }

    private void StreakTextTick()
    {
        if (_streakText.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, fx) in _streakText.ToList())
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            if (!fx.Main.IsValid || p is not { IsValid: true, PawnIsAlive: true } || p.PlayerPawn.Value is not { IsValid: true } pawn) { RemoveStreakText(slot); continue; }
            PlaceFx(fx, pawn, now - fx.Born);
        }
    }

    private void RemoveStreakText(int slot)
    {
        if (!_streakText.Remove(slot, out var fx)) return;
        foreach (var e in fx.All()) if (e.IsValid) e.Remove();
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
            foreach (var (slot, fx) in _streakText)
            {
                if (slot == viewer.Slot) continue;
                var owner = Utilities.GetPlayerFromSlot(slot);
                if (target is { IsValid: true } && owner?.PlayerPawn.Value is { IsValid: true } op && op.Handle == target.Handle) continue;
                foreach (var e in fx.All()) if (e.IsValid) info.TransmitEntities.Remove(e);
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
