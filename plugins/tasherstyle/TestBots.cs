// Тестовые боты: в начале каждого раунда (пока идёт заморозка) боты переносятся на точки «мида», которые админ
// отметил на карте командой !botmid — дальше они сами идут в бой через мид.
// Команды (админ с @css/root или консоль сервера):
//   !botmid         — добавить точку там, где стоишь (можно несколько — боты распределяются по ним)
//   !botmid clear   — убрать точки этой карты     !botmid on | off — включить / выключить     !botmid list — показать
// Точки и включение хранятся в botmid.json рядом с плагином (сохраняются после перезапуска).
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    private sealed class BotMidData
    {
        public bool Enabled { get; set; }
        public Dictionary<string, List<float[]>> Maps { get; set; } = new();
    }

    private BotMidData _botMid = new();
    private string BotMidPath => Path.Combine(ModuleDirectory, "botmid.json");

    private void LoadTestBots()
    {
        try { if (File.Exists(BotMidPath)) _botMid = JsonSerializer.Deserialize<BotMidData>(File.ReadAllText(BotMidPath)) ?? new(); }
        catch (Exception ex) { Logger.LogWarning("botmid.json не прочитался: {Err}", ex.Message); _botMid = new(); }
        AddCommand("css_botmid", "Точки мида для тестовых ботов: !botmid | clear | on | off | list", CmdBotMid);
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            if (_botMid.Enabled) AddTimer(0.6f, MoveBotsToMid, TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
    }

    private void SaveBotMid()
    {
        try { File.WriteAllText(BotMidPath, JsonSerializer.Serialize(_botMid, new JsonSerializerOptions { WriteIndented = true })); }
        catch (Exception ex) { Logger.LogWarning("botmid.json не записался: {Err}", ex.Message); }
    }

    private void MoveBotsToMid()
    {
        if (!_botMid.Enabled || !_botMid.Maps.TryGetValue(Server.MapName, out var pts) || pts.Count == 0) return;
        var bots = Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: true, IsHLTV: false } && IsAlive(p)).ToList();
        for (int i = 0; i < bots.Count; i++)
        {
            var pt = pts[i % pts.Count];
            // на одной точке несколько ботов — ставим кругом радиусом 48 юнитов, чтобы не застряли друг в друге
            int perPoint = (bots.Count + pts.Count - 1) / pts.Count, g = i / pts.Count;
            float dx = 0, dy = 0;
            if (perPoint > 1) { var a = g * Math.PI * 2 / perPoint; dx = (float)(Math.Cos(a) * 48); dy = (float)(Math.Sin(a) * 48); }
            var pawn = bots[i].PlayerPawn.Value;
            if (pawn is not { IsValid: true }) continue;
            pawn.Teleport(new Vector(pt[0] + dx, pt[1] + dy, pt[2] + 4), new QAngle(0, pt.Length > 3 ? pt[3] : 0, 0), new Vector(0, 0, 0));
        }
    }

    private void CmdBotMid(CCSPlayerController? p, CommandInfo info)
    {
        if (p != null && !AdminManager.PlayerHasPermissions(p, "@css/root")) { info.ReplyToCommand("[TASHER] Нет доступа"); return; }
        var arg = info.ArgCount > 1 ? info.GetArg(1).Trim().ToLowerInvariant() : "";
        var map = Server.MapName;
        _botMid.Maps.TryGetValue(map, out var pts);
        switch (arg)
        {
            case "on": _botMid.Enabled = true; SaveBotMid(); info.ReplyToCommand($"[TASHER] Боты на мид: включено (точек на {map}: {pts?.Count ?? 0})"); return;
            case "off": _botMid.Enabled = false; SaveBotMid(); info.ReplyToCommand("[TASHER] Боты на мид: выключено"); return;
            case "clear": _botMid.Maps.Remove(map); SaveBotMid(); info.ReplyToCommand($"[TASHER] Точки мида на {map} удалены"); return;
            case "list":
                info.ReplyToCommand($"[TASHER] Боты на мид: {(_botMid.Enabled ? "включено" : "выключено")}, точек на {map}: {pts?.Count ?? 0}");
                if (pts != null) foreach (var x in pts) info.ReplyToCommand($"  {x[0]:0} {x[1]:0} {x[2]:0}");
                return;
            case "":
                var pawn = p?.PlayerPawn.Value;
                var o = pawn?.CBodyComponent?.SceneNode?.AbsOrigin;
                if (pawn == null || o == null || p == null || !IsAlive(p)) { info.ReplyToCommand("[TASHER] Встань живым в нужное место на миде и напиши !botmid"); return; }
                if (pts == null) { pts = new(); _botMid.Maps[map] = pts; }
                if (pts.Count >= 10) { info.ReplyToCommand("[TASHER] Уже 10 точек — сначала !botmid clear"); return; }
                pts.Add(new[] { o.X, o.Y, o.Z, pawn.EyeAngles.Y });
                _botMid.Enabled = true; SaveBotMid();
                info.ReplyToCommand($"[TASHER] Точка мида {pts.Count} сохранена. Со следующего раунда боты появляются здесь");
                return;
            default: info.ReplyToCommand("[TASHER] !botmid — добавить точку, !botmid clear | on | off | list"); return;
        }
    }
}
