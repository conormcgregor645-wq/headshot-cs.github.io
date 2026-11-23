// Эффекты, купленные на сайте: эффект убийства, звук убийства, трассеры пуль и светящийся след гранат.
// Всё рисуется лучами (entity "beam") — они есть в самой игре, игрокам ничего скачивать не нужно.
using System.Drawing;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace TasherStyle;

public partial class TasherStyle
{
    private static readonly string[] FxColumns = { "kill_fx", "kill_snd", "trail", "tracer", "mvp_snd" };
    private int _beams;
    private int _tick;
    private readonly List<GrenadeTrail> _trails = new();
    private readonly Dictionary<ulong, DateTime> _lastTracer = new();
    // Лучи эффекта фрага передаются только самому убийце и тем, кто за ним наблюдает.
    private readonly Dictionary<CBeam, ulong> _spectatorBeams = new();
    private ulong _killFxOwner;

    private sealed class GrenadeTrail
    {
        public required CBaseCSGrenadeProjectile G;
        public Color C;
        public float X, Y, Z;
        public int Still, Age;
    }

    private void LoadEffects()
    {
        RegisterEventHandler<EventBulletImpact>(OnBulletImpact);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventRoundMvp>(OnRoundMvp);
        RegisterListener<Listeners.OnTick>(OnTick);
        RegisterListener<Listeners.CheckTransmit>(OnEffectsTransmit);
        RegisterListener<Listeners.OnMapStart>(_ => { _beams = 0; _trails.Clear(); _lastTracer.Clear(); _spectatorBeams.Clear(); _killFxOwner = 0; });
    }

    // "r,g,b" или "random" -> цвет
    private static bool TryColor(string s, out Color c)
    {
        if (s == "random") { c = RandomBright(); return true; }
        if (TryRgb(s, out var r, out var g, out var b)) { c = Color.FromArgb(255, (int)r, (int)g, (int)b); return true; }
        c = Color.White; return false;
    }

    private static readonly Color[] Palette =
    {
        Color.FromArgb(255, 181, 232, 83), Color.FromArgb(255, 255, 107, 139), Color.FromArgb(255, 56, 211, 255),
        Color.FromArgb(255, 245, 196, 81), Color.FromArgb(255, 167, 139, 250), Color.FromArgb(255, 255, 138, 61),
    };
    private static Color RandomBright() => Palette[Random.Shared.Next(Palette.Length)];

    // один луч от точки до точки, сам исчезает через life секунд
    private void Beam(float x1, float y1, float z1, float x2, float y2, float z2, Color color, float width, float life)
    {
        if (_beams >= Math.Max(50, Config.MaxBeams)) return;
        var beam = Utilities.CreateEntityByName<CBeam>("beam");
        if (beam == null || !beam.IsValid) return;
        beam.Render = color;
        beam.Width = width;
        beam.EndWidth = width;
        beam.Teleport(new Vector(x1, y1, z1), new QAngle(0, 0, 0), new Vector(0, 0, 0));
        beam.EndPos.X = x2; beam.EndPos.Y = y2; beam.EndPos.Z = z2;
        beam.DispatchSpawn();
        if (_killFxOwner != 0) _spectatorBeams[beam] = _killFxOwner;
        _beams++;
        AddTimer(life, () =>
        {
            _beams = Math.Max(0, _beams - 1);
            _spectatorBeams.Remove(beam);
            if (beam.IsValid) beam.Remove();
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    // Проверка сетевой передачи происходит отдельно для каждого зрителя.
    // Владелец эффекта видит его всегда. Другие живые игроки не получают эффект, даже если находятся рядом с местом убийства;
    // мёртвые и зрители видят его, только когда наблюдают за владельцем.
    private void OnEffectsTransmit(CCheckTransmitInfoList infoList)
    {
        if (_spectatorBeams.Count == 0) return;
        // Кэшируем владельцев pawn один раз на сетевой вызов, а не для каждого зрителя.
        var pawnOwners = new Dictionary<nint, ulong>();
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false } &&
                p.PlayerPawn.Value is { IsValid: true } pawn)
                pawnOwners[pawn.Handle] = p.SteamID;
        foreach (var (info, viewer) in infoList)
        {
            if (viewer is not { IsValid: true } || viewer.IsBot || viewer.IsHLTV) continue;
            ulong watching = 0;
            if (!viewer.PawnIsAlive)
            {
                var target = viewer.PlayerPawn.Value?.ObserverServices?.ObserverTarget.Value
                    ?? viewer.ObserverPawn.Value?.ObserverServices?.ObserverTarget.Value;
                if (target is { IsValid: true } &&
                    pawnOwners.TryGetValue(target.Handle, out var ownerSid))
                    watching = ownerSid;
            }
            var self = viewer.SteamID;
            // эффект видит сам владелец и те, кто за ним наблюдает; остальным живым игрокам он не передаётся
            foreach (var (beam, ownerSid) in _spectatorBeams)
                if (beam.IsValid && self != ownerSid && watching != ownerSid) info.TransmitEntities.Remove(beam);
        }
    }

    // --- трассеры пуль: луч от глаз стрелка до места попадания, виден всем ---
    private HookResult OnBulletImpact(EventBulletImpact e, GameEventInfo info)
    {
        var p = e.Userid;
        if (p is not { IsValid: true } || p.IsBot || p.IsHLTV) return HookResult.Continue;
        var s = StyleOf(p);
        if (s == null || s.Tracer.Length == 0 || !TryColor(s.Tracer, out var c)) return HookResult.Continue;
        // Ограничиваем сетевые лучи: дробь и несколько impact одного выстрела не создают десятки сущностей.
        var now = DateTime.UtcNow;
        if (_lastTracer.TryGetValue(p.SteamID, out var last) && (now - last).TotalMilliseconds < 90) return HookResult.Continue;
        _lastTracer[p.SteamID] = now;
        var pawn = p.PlayerPawn.Value;
        if (pawn is not { IsValid: true } || pawn.AbsOrigin is not { } o) return HookResult.Continue;
        float ex = o.X, ey = o.Y, ez = o.Z + (float)pawn.ViewOffset.Z;
        float dx = e.X - ex, dy = e.Y - ey, dz = e.Z - ez;
        var len = MathF.Sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 48f) return HookResult.Continue;
        var k = 24f / len; // начинаем чуть впереди и ниже глаз, чтобы луч не закрывал прицел
        Beam(ex + dx * k, ey + dy * k, ez + dz * k - 3f, e.X, e.Y, e.Z, c, 0.9f, 0.12f);
        return HookResult.Continue;
    }

    // --- убийство: звук убившему и эффект на месте фрага ---
    private HookResult OnPlayerDeath(EventPlayerDeath e, GameEventInfo info)
    {
        var a = e.Attacker;
        var v = e.Userid;
        if (a is not { IsValid: true } || a.IsBot || a.IsHLTV || v is not { IsValid: true } || a.Slot == v.Slot) return HookResult.Continue;
        var s = StyleOf(a);
        if (s == null) return HookResult.Continue;
        if (s.KillSnd.Length > 0 && Config.KillSounds.TryGetValue(s.KillSnd, out var snd) && IsSafeSound(snd))
            a.ExecuteClientCommand($"play {snd}");
        if (s.KillFx.Length > 0)
        {
            var vp = v.PlayerPawn.Value;
            if (vp is { IsValid: true } && vp.AbsOrigin is { } o)
            {
                _killFxOwner = a.SteamID;
                try { KillEffect(s.KillFx, o.X, o.Y, o.Z); }
                finally { _killFxOwner = 0; }
            }
        }
        return HookResult.Continue;
    }

    // --- MVP раунда: свой звук слышат все игроки на сервере ---
    private HookResult OnRoundMvp(EventRoundMvp e, GameEventInfo info)
    {
        var m = e.Userid;
        if (m is not { IsValid: true } || m.IsBot || m.IsHLTV) return HookResult.Continue;
        var s = StyleOf(m);
        if (s == null || s.MvpSnd.Length == 0 || !Config.MvpSounds.TryGetValue(s.MvpSnd, out var snd) || !IsSafeSound(snd)) return HookResult.Continue;
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false, IsHLTV: false }) p.ExecuteClientCommand($"play {snd}");
        return HookResult.Continue;
    }

    private static bool IsSafeSound(string s) => s.Length is > 0 and < 128 && s.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '/' or '_' or '.' or '-');

    private void KillEffect(string kind, float x, float y, float z)
    {
        var rnd = Random.Shared;
        switch (kind)
        {
            case "spark": // искры: короткие лучи во все стороны из груди
            {
                Color[] cols = { Color.FromArgb(255, 255, 211, 107), Color.FromArgb(255, 255, 138, 61), Color.White };
                float cz = z + 40f;
                for (var i = 0; i < 14; i++)
                {
                    var (dx, dy, dz) = RandomDir(rnd);
                    var r1 = 6f + rnd.NextSingle() * 6f; var r2 = 26f + rnd.NextSingle() * 22f;
                    Beam(x + dx * r1, y + dy * r1, cz + dz * r1, x + dx * r2, y + dy * r2, cz + dz * r2, cols[i % cols.Length], 1.6f, 0.5f);
                }
                break;
            }
            case "bolt": // разряд: ломаная молния с неба в место фрага
            {
                var blue = Color.FromArgb(255, 56, 211, 255);
                const int seg = 8;
                float px = x, py = y, pz = z + 520f;
                for (var i = 1; i <= seg; i++)
                {
                    var last = i == seg;
                    float nx = last ? x : x + (rnd.NextSingle() - 0.5f) * 44f;
                    float ny = last ? y : y + (rnd.NextSingle() - 0.5f) * 44f;
                    float nz = z + 520f - 515f * i / seg;
                    Beam(px, py, pz, nx, ny, nz, blue, 4f, 0.45f);
                    Beam(px, py, pz, nx, ny, nz, Color.White, 1.2f, 0.45f);
                    px = nx; py = ny; pz = nz;
                }
                for (var i = 0; i < 6; i++)
                {
                    var ang = i * MathF.PI / 3f;
                    Beam(x, y, z + 3f, x + MathF.Cos(ang) * 34f, y + MathF.Sin(ang) * 34f, z + 3f, blue, 2f, 0.45f);
                }
                break;
            }
            case "conf": // конфетти: разноцветные кусочки вокруг
            {
                for (var i = 0; i < 26; i++)
                {
                    var ang = rnd.NextSingle() * MathF.Tau; var rad = rnd.NextSingle() * 52f;
                    float cx = x + MathF.Cos(ang) * rad, cy = y + MathF.Sin(ang) * rad, cz = z + 14f + rnd.NextSingle() * 80f;
                    var (dx, dy, dz) = RandomDir(rnd);
                    Beam(cx, cy, cz, cx + dx * 6f, cy + dy * 6f, cz + dz * 6f, Palette[i % Palette.Length], 2.6f, 1.2f);
                }
                break;
            }
            case "ring": // кольцо: два золотых круга на земле и столб света
            {
                var gold = Color.FromArgb(255, 245, 196, 81);
                Circle(x, y, z + 4f, 42f, 16, gold, 3f, 1.1f);
                Circle(x, y, z + 4f, 22f, 12, Color.White, 1.6f, 1.1f);
                Beam(x, y, z + 4f, x, y, z + 140f, gold, 2.4f, 0.8f);
                break;
            }
            case "frost": // снежинка: шестилучевая ледяная звезда на земле и снежная пыль
            {
                var ice = Color.FromArgb(255, 125, 211, 252);
                float gz = z + 4f;
                for (var i = 0; i < 6; i++)
                {
                    var a = i * MathF.PI / 3f; float cx = MathF.Cos(a), cy = MathF.Sin(a);
                    Beam(x, y, gz, x + cx * 46f, y + cy * 46f, gz, ice, 2.6f, 1.2f);
                    foreach (var (d, l) in new[] { (20f, 12f), (32f, 9f) })
                        foreach (var sgn in new[] { -1f, 1f })
                        {
                            var b = a + sgn * 0.75f;
                            Beam(x + cx * d, y + cy * d, gz, x + cx * d + MathF.Cos(b) * l, y + cy * d + MathF.Sin(b) * l, gz, Color.White, 1.4f, 1.2f);
                        }
                }
                for (var i = 0; i < 10; i++)
                {
                    var ang = rnd.NextSingle() * MathF.Tau; var rad = rnd.NextSingle() * 40f;
                    float px = x + MathF.Cos(ang) * rad, py = y + MathF.Sin(ang) * rad, pz = z + 20f + rnd.NextSingle() * 70f;
                    Beam(px, py, pz, px, py, pz - 5f, Color.White, 2.2f, 1.3f);
                }
                break;
            }
            case "fire": // пламя: языки огня поднимаются из места фрага
            {
                Color[] cols = { Color.FromArgb(255, 255, 90, 40), Color.FromArgb(255, 255, 160, 50), Color.FromArgb(255, 255, 220, 110) };
                for (var i = 0; i < 12; i++)
                {
                    var ang = MathF.Tau * i / 12f + rnd.NextSingle() * 0.4f; var rad = 8f + rnd.NextSingle() * 18f;
                    float bx = x + MathF.Cos(ang) * rad, by = y + MathF.Sin(ang) * rad, h = 50f + rnd.NextSingle() * 60f;
                    float mx = bx + (rnd.NextSingle() - 0.5f) * 14f, my = by + (rnd.NextSingle() - 0.5f) * 14f;
                    Beam(bx, by, z + 2f, mx, my, z + h * 0.55f, cols[i % 3], 4f, 0.7f);
                    Beam(mx, my, z + h * 0.55f, x + (bx - x) * 0.3f, y + (by - y) * 0.3f, z + h, cols[(i + 1) % 3], 2f, 0.7f);
                }
                break;
            }
            case "tornado": // вихрь: зелёная спираль закручивается вверх
            {
                var lime = Color.FromArgb(255, 181, 232, 83);
                const int n = 30;
                float px = x + 10f, py = y, pz = z + 2f;
                for (var i = 1; i <= n; i++)
                {
                    float t = (float)i / n, ang = t * MathF.Tau * 3f, rad = 10f + t * 44f;
                    float nx = x + MathF.Cos(ang) * rad, ny = y + MathF.Sin(ang) * rad, nz = z + 2f + t * 150f;
                    Beam(px, py, pz, nx, ny, nz, i % 3 == 0 ? Color.White : lime, 2.4f, 0.9f);
                    px = nx; py = ny; pz = nz;
                }
                break;
            }
            case "star": // звезда: золотая пятиконечная звезда на земле и столб света
            {
                var gold = Color.FromArgb(255, 255, 207, 64);
                float gz = z + 4f; var pts = new (float X, float Y)[10];
                for (var i = 0; i < 10; i++)
                {
                    var a = -MathF.PI / 2f + i * MathF.PI / 5f; var r = i % 2 == 0 ? 50f : 20f;
                    pts[i] = (x + MathF.Cos(a) * r, y + MathF.Sin(a) * r);
                }
                for (var i = 0; i < 10; i++) { var (ax, ay) = pts[i]; var (bx, by) = pts[(i + 1) % 10]; Beam(ax, ay, gz, bx, by, gz, gold, 3f, 1.2f); }
                Beam(x, y, gz, x, y, z + 170f, gold, 3f, 0.9f);
                Beam(x, y, gz, x, y, z + 170f, Color.White, 1f, 0.9f);
                break;
            }
            case "rainbow": // радуга: цветная дуга над местом фрага
            {
                Color[] rb = { Color.FromArgb(255, 255, 80, 80), Color.FromArgb(255, 255, 160, 60), Color.FromArgb(255, 255, 230, 80),
                               Color.FromArgb(255, 120, 230, 100), Color.FromArgb(255, 70, 170, 255), Color.FromArgb(255, 160, 100, 255) };
                var dir = rnd.NextSingle() * MathF.Tau; float ux = MathF.Cos(dir), uy = MathF.Sin(dir);
                const int seg = 8;
                for (var k = 0; k < rb.Length; k++)
                {
                    var r = 70f - k * 6f;
                    for (var i = 0; i < seg; i++)
                    {
                        float a1 = MathF.PI * i / seg, a2 = MathF.PI * (i + 1) / seg;
                        Beam(x + ux * MathF.Cos(a1) * r, y + uy * MathF.Cos(a1) * r, z + 4f + MathF.Sin(a1) * r,
                             x + ux * MathF.Cos(a2) * r, y + uy * MathF.Cos(a2) * r, z + 4f + MathF.Sin(a2) * r, rb[k], 3f, 1.4f);
                    }
                }
                break;
            }
            case "storm": // снежная буря (эксклюзив Winter Ops): ледяная воронка, кольца инея и снег
            {
                Color[] cols = { Color.FromArgb(255, 159, 220, 255), Color.FromArgb(255, 94, 240, 200), Color.FromArgb(255, 232, 247, 255) };
                float gz = z + 4f;
                for (var arm = 0; arm < 3; arm++)
                    for (var i = 0; i < 12; i++)
                    {
                        float t1 = i / 12f, t2 = (i + 1) / 12f, a0 = arm * MathF.Tau / 3f;
                        float a1 = a0 + t1 * MathF.Tau * 1.2f, a2 = a0 + t2 * MathF.Tau * 1.2f, r1 = 12f + t1 * 40f, r2 = 12f + t2 * 40f;
                        Beam(x + MathF.Cos(a1) * r1, y + MathF.Sin(a1) * r1, gz + t1 * 110f, x + MathF.Cos(a2) * r2, y + MathF.Sin(a2) * r2, gz + t2 * 110f, cols[arm], 2f, 1.1f);
                    }
                Circle(x, y, gz, 48f, 18, cols[0], 2.4f, 1.2f);
                Circle(x, y, gz, 30f, 14, cols[1], 1.6f, 1.2f);
                for (var i = 0; i < 16; i++)
                {
                    var ang = rnd.NextSingle() * MathF.Tau; var rad = rnd.NextSingle() * 55f;
                    float px = x + MathF.Cos(ang) * rad, py = y + MathF.Sin(ang) * rad, pz = z + 15f + rnd.NextSingle() * 100f;
                    Beam(px, py, pz, px + 3f, py, pz - 6f, Color.White, 2.2f, 1.4f);
                }
                break;
            }
            case "nova": // сверхновая: фиолетово-розовый взрыв лучей во все стороны
            {
                Color[] cols = { Color.FromArgb(255, 200, 90, 255), Color.FromArgb(255, 255, 90, 200), Color.White };
                float cz = z + 40f;
                for (var i = 0; i < 22; i++)
                {
                    var (dx, dy, dz) = RandomDir(rnd);
                    var r2 = 50f + rnd.NextSingle() * 40f;
                    Beam(x + dx * 4f, y + dy * 4f, cz + dz * 4f, x + dx * r2, y + dy * r2, cz + dz * r2, cols[i % cols.Length], i % 3 == 2 ? 1f : 2.2f, 0.6f);
                }
                Circle(x, y, cz, 26f, 14, cols[0], 2f, 0.6f);
                break;
            }
        }
    }

    private void Circle(float x, float y, float z, float r, int n, Color c, float w, float life)
    {
        for (var i = 0; i < n; i++)
        {
            float a1 = MathF.Tau * i / n, a2 = MathF.Tau * (i + 1) / n;
            Beam(x + MathF.Cos(a1) * r, y + MathF.Sin(a1) * r, z, x + MathF.Cos(a2) * r, y + MathF.Sin(a2) * r, z, c, w, life);
        }
    }

    private static (float, float, float) RandomDir(Random rnd)
    {
        var z = rnd.NextSingle() * 2f - 1f;
        var a = rnd.NextSingle() * MathF.Tau;
        var r = MathF.Sqrt(1f - z * z);
        return (MathF.Cos(a) * r, MathF.Sin(a) * r, z);
    }

    // --- след гранаты: каждые 4 тика луч от прошлой точки до текущей ---
    private void StartTrail(CBaseCSGrenadeProjectile g, Color c)
    {
        if (g.AbsOrigin is not { } o || _trails.Count >= 32) return;
        _trails.Add(new GrenadeTrail { G = g, C = c, X = o.X, Y = o.Y, Z = o.Z });
    }

    private void OnTick()
    {
        if (_trails.Count == 0 || ++_tick % 7 != 0) return;
        for (var i = _trails.Count - 1; i >= 0; i--)
        {
            var t = _trails[i];
            if (!t.G.IsValid || t.G.AbsOrigin is not { } o || ++t.Age > 95) { _trails.RemoveAt(i); continue; }
            float dx = o.X - t.X, dy = o.Y - t.Y, dz = o.Z - t.Z;
            if (dx * dx + dy * dy + dz * dz < 4f)
            {
                if (++t.Still > 8) _trails.RemoveAt(i); // граната легла — след больше не нужен
                continue;
            }
            t.Still = 0;
            Beam(t.X, t.Y, t.Z, o.X, o.Y, o.Z, t.C, 1.6f, 0.35f);
            t.X = o.X; t.Y = o.Y; t.Z = o.Z;
        }
    }
}
