// Закрытые проходы при малом онлайне: пока в командах меньше SmallOnlineBelow живых людей (2×2, 1×1),
// отмеченные проходы (на Dust2 — мид, нижние туннели, Б) закрыты лазерной стеной: пройти сквозь неё нельзя, игрока возвращает назад.
// Проходы отмечает админ (@css/root) прямо в игре — один раз для каждой карты:
//   !wall a            — встать в один угол прохода (на полу) и отметить его
//   !wall b <название> — встать в противоположный угол и сохранить проход (высота стены — 2,5 м от пола)
//   !wall list         — список проходов этой карты     !wall del <номер> — удалить     !wall clear — удалить все
//   !wall test         — включить стены сейчас, независимо от онлайна (повторно — выключить)
// Проходы хранятся в walls.json рядом с плагином.
using System.Drawing;
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
    public sealed class WallBox
    {
        public string Name { get; set; } = "";
        public float[] Min { get; set; } = new float[3];
        public float[] Max { get; set; } = new float[3];
    }

    private Dictionary<string, List<WallBox>> _walls = new();
    private readonly Dictionary<int, float[]> _wallCornerA = new();
    private readonly Dictionary<int, (float X, float Y, float Z)> _safePos = new();
    private readonly Dictionary<int, float> _wallWarned = new();
    private bool _wallsActive, _wallsTest;
    private int _wallTick;
    private string WallsPath => Path.Combine(ModuleDirectory, "walls.json");

    private List<WallBox> MapWalls => _walls.TryGetValue(Server.MapName, out var l) ? l : new List<WallBox>();

    private void LoadWalls()
    {
        try { if (File.Exists(WallsPath)) _walls = JsonSerializer.Deserialize<Dictionary<string, List<WallBox>>>(File.ReadAllText(WallsPath)) ?? new(); }
        catch (Exception ex) { Logger.LogWarning("walls.json не прочитался: {Err}", ex.Message); _walls = new(); }
        AddCommand("css_wall", "Закрытые проходы при малом онлайне: !wall a | b <название> | list | del <n> | clear | test", CmdWall);
        RegisterListener<Listeners.OnMapStart>(_ => { _safePos.Clear(); _wallsTest = false; _wallsActive = false; });
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            var was = _wallsActive;
            _wallsActive = WallsShouldBeOn();
            _safePos.Clear();
            if (_wallsActive && MapWalls.Count > 0)
                Server.PrintToChatAll($"{Prefix}Игроков меньше {Config.SmallOnlineBelow}: {ChatColors.Red}закрыто{ChatColors.Default} — {string.Join(", ", MapWalls.Select(w => w.Name))}.");
            else if (was && MapWalls.Count > 0)
                Server.PrintToChatAll($"{Prefix}Игроков {Config.SmallOnlineBelow}+ — все проходы {ChatColors.Lime}открыты{ChatColors.Default}.");
            return HookResult.Continue;
        });
        RegisterListener<Listeners.OnTick>(WallsTick);
    }

    private bool WallsShouldBeOn()
    {
        if (_wallsTest) return true;
        if (Config.SmallOnlineBelow <= 0) return false;
        var humans = Utilities.GetPlayers().Count(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.Team is CsTeam.Terrorist or CsTeam.CounterTerrorist);
        return humans > 0 && humans < Config.SmallOnlineBelow;
    }

    private static bool Inside(WallBox w, float x, float y, float z) =>
        x >= w.Min[0] && x <= w.Max[0] && y >= w.Min[1] && y <= w.Max[1] && z >= w.Min[2] && z <= w.Max[2];

    private void WallsTick()
    {
        if (!_wallsActive) return;
        var walls = MapWalls; if (walls.Count == 0) return;
        _wallTick++;
        // проверка положения — 16 раз в секунду
        if (_wallTick % 4 == 0)
            foreach (var p in Utilities.GetPlayers())
            {
                if (p is not { IsValid: true, IsHLTV: false } || !p.PawnIsAlive || p.PlayerPawn.Value is not { } pawn || pawn.AbsOrigin is not { } o) continue;
                var hit = walls.FirstOrDefault(w => Inside(w, o.X, o.Y, o.Z));
                if (hit == null) { _safePos[p.Slot] = (o.X, o.Y, o.Z); continue; }
                if (_safePos.TryGetValue(p.Slot, out var s))
                    pawn.Teleport(new Vector(s.X, s.Y, s.Z), null, new Vector(0, 0, 0));
                var now = Server.CurrentTime;
                if (!p.IsBot && (!_wallWarned.TryGetValue(p.Slot, out var t) || now - t > 2f))
                {
                    _wallWarned[p.Slot] = now;
                    p.PrintToCenterHtml($"<font color='#ff6b6b'>Проход «{hit.Name}» закрыт</font><br><font color='#cfcfcf'>откроется, когда игроков будет {Config.SmallOnlineBelow}+</font>", 2);
                }
            }
        // лазерная сетка на границах — обновляем раз в секунду
        if (_wallTick % 64 == 0)
        {
            var red = Color.FromArgb(255, 255, 70, 70);
            foreach (var w in walls)
            {
                float x0 = w.Min[0], y0 = w.Min[1], z0 = w.Min[2] + 8, x1 = w.Max[0], y1 = w.Max[1], z1 = w.Max[2];
                for (var k = 0; k <= 3; k++)
                {
                    var z = z0 + (z1 - z0) * k / 3f;
                    Beam(x0, y0, z, x1, y0, z, red, 1.2f, 1.05f); Beam(x1, y0, z, x1, y1, z, red, 1.2f, 1.05f);
                    Beam(x1, y1, z, x0, y1, z, red, 1.2f, 1.05f); Beam(x0, y1, z, x0, y0, z, red, 1.2f, 1.05f);
                }
                foreach (var (cx, cy) in new[] { (x0, y0), (x1, y0), (x1, y1), (x0, y1) }) Beam(cx, cy, z0, cx, cy, z1, red, 1.2f, 1.05f);
            }
        }
    }

    private void SaveWalls()
    {
        try { File.WriteAllText(WallsPath, JsonSerializer.Serialize(_walls, new JsonSerializerOptions { WriteIndented = true })); }
        catch (Exception ex) { Logger.LogError("walls.json не сохранился: {Err}", ex.Message); }
    }

    private void CmdWall(CCSPlayerController? p, CommandInfo info)
    {
        if (p != null && !AdminManager.PlayerHasPermissions(p, "@css/root")) { p.PrintToChat($"{Prefix}Нет доступа"); return; }
        void Say(string m) { if (p != null) p.PrintToChat(Prefix + m); else Console.WriteLine("[TASHER] " + m); }
        var arg = info.GetArg(1).ToLowerInvariant();
        var map = Server.MapName;
        if (!_walls.ContainsKey(map)) _walls[map] = new();
        var list = _walls[map];
        switch (arg)
        {
            case "a":
            case "b":
            {
                if (p?.PlayerPawn.Value?.AbsOrigin is not { } o) { Say("Встань на карте живым игроком"); return; }
                if (arg == "a") { _wallCornerA[p.Slot] = new[] { o.X, o.Y, o.Z }; Say($"Угол А отмечен. Встань в противоположный угол и напиши {ChatColors.Lime}!wall b <название>"); return; }
                if (!_wallCornerA.TryGetValue(p.Slot, out var a)) { Say("Сначала отметь угол А: !wall a"); return; }
                var name = info.ArgCount > 2 ? info.ArgString[(info.ArgString.IndexOf(' ') + 1)..].Trim() : $"проход {list.Count + 1}";
                var w = new WallBox
                {
                    Name = name.Length > 32 ? name[..32] : name,
                    Min = new[] { MathF.Min(a[0], o.X) - 4, MathF.Min(a[1], o.Y) - 4, MathF.Min(a[2], o.Z) - 24 },
                    Max = new[] { MathF.Max(a[0], o.X) + 4, MathF.Max(a[1], o.Y) + 4, MathF.Max(a[2], o.Z) + 160 },
                };
                list.Add(w); _wallCornerA.Remove(p.Slot); SaveWalls();
                Say($"Проход «{w.Name}» сохранён ({list.Count} на {map}). Проверить: !wall test");
                return;
            }
            case "list":
                Say(list.Count == 0 ? $"На {map} проходов нет" : $"{map}: " + string.Join("; ", list.Select((w, i) => $"{i + 1}. {w.Name}")));
                return;
            case "del":
                if (int.TryParse(info.GetArg(2), out var n) && n >= 1 && n <= list.Count) { var w = list[n - 1]; list.RemoveAt(n - 1); SaveWalls(); Say($"Удалён «{w.Name}»"); }
                else Say("!wall del <номер из !wall list>");
                return;
            case "clear": list.Clear(); SaveWalls(); Say($"Все проходы {map} удалены"); return;
            case "test": _wallsTest = !_wallsTest; _wallsActive = WallsShouldBeOn(); Say(_wallsTest ? "Стены включены для проверки" : "Проверка выключена — стены снова по онлайну"); return;
            default: Say("!wall a | b <название> | list | del <n> | clear | test"); return;
        }
    }
}
