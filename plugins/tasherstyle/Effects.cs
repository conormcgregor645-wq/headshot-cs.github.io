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
    // Лучи эффектов (убийство, трассеры, след гранат) передаются только владельцу и тем, кто за ним наблюдает.
    private readonly Dictionary<CBeam, ulong> _spectatorBeams = new();
    private ulong _killFxOwner;

    private sealed class GrenadeTrail
    {
        public required CBaseCSGrenadeProjectile G;
        public Color C;
        public ulong Owner;
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

    // --- трассеры пуль: луч от глаз стрелка до места попадания; видят стрелок и наблюдающие за ним ---
    private HookResult OnBulletImpact(EventBulletImpact e, GameEventInfo info)
    {
        var p = e.Userid;
        if (p is not { IsValid: true } || p.IsBot || p.IsHLTV) return HookResult.Continue;
        var s = StyleOf(p);
        // белый трассер есть у всех; цветной — купленный на сайте; в !menu можно выключить
        if (!PrefOn(p.SteamID, OffTracer) || !TryColor(s is { Tracer.Length: > 0 } ? s.Tracer : DefaultWhite, out var c)) return HookResult.Continue;
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
        // трассер видит сам стрелок и те, кто за ним наблюдает (как эффект убийства)
        Frame(0, p.SteamID, () => Beam(ex + dx * k, ey + dy * k, ez + dz * k - 3f, e.X, e.Y, e.Z, c, 0.9f, 0.12f));
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
        if (s.KillSnd.Length > 0 && PrefOn(a.SteamID, OffKillSnd) && Config.KillSounds.TryGetValue(s.KillSnd, out var snd) && IsSafeSound(snd))
            a.ExecuteClientCommand($"play {snd}");
        if (s.KillFx.Length > 0 && PrefOn(a.SteamID, OffKillFx))
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
        if (s == null || s.MvpSnd.Length == 0 || !PrefOn(m.SteamID, OffMvp) || !Config.MvpSounds.TryGetValue(s.MvpSnd, out var snd) || !IsSafeSound(snd)) return HookResult.Continue;
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false, IsHLTV: false }) p.ExecuteClientCommand($"play {snd}");
        return HookResult.Continue;
    }

    private static bool IsSafeSound(string s) => s.Length is > 0 and < 128 && s.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '/' or '_' or '.' or '-');

    // Кадр анимации: рисуется через delay секунд; лучи кадра видны тем же, кому весь эффект (владелец и наблюдающие за ним)
    private void Frame(float delay, ulong owner, Action draw)
    {
        void Run()
        {
            var prev = _killFxOwner; _killFxOwner = owner;
            try { draw(); } finally { _killFxOwner = prev; }
        }
        if (delay <= 0.001f) Run(); else AddTimer(delay, Run, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static Color Mix(Color a, Color b, float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        return Color.FromArgb(255, (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
    }

    // Эффекты убийства анимированы: каждый собирается из коротких кадров (лучи живут 0.05–0.1 с и сменяют друг друга),
    // поэтому искры летят, кольца расходятся, пламя поднимается, а вихрь вращается.
    private void KillEffect(string kind, float x, float y, float z)
    {
        var rnd = Random.Shared;
        var owner = _killFxOwner;
        const float F = 0.05f; // шаг кадра
        switch (kind)
        {
            case "spark": // искры: разлетаются из груди и падают по дуге, остывая от белого к оранжевому
            {
                float cz = z + 42f;
                var dirs = Enumerable.Range(0, 14).Select(_ => RandomDir(rnd)).ToArray();
                var sp = dirs.Select(_ => 1.4f + rnd.NextSingle() * 0.8f).ToArray();
                Color hot = Color.FromArgb(255, 255, 250, 220), warm = Color.FromArgb(255, 255, 196, 81), cold = Color.FromArgb(255, 255, 110, 40);
                for (var f = 0; f < 9; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        for (var i = 0; i < dirs.Length; i++)
                        {
                            var (dx, dy, dz) = dirs[i];
                            float r1 = (6f + ff * 9f) * sp[i], r2 = r1 + 10f, g1 = ff * ff * 0.9f, g2 = (ff + 0.6f) * (ff + 0.6f) * 0.9f;
                            var c = ff < 3 ? Mix(hot, warm, ff / 3f) : Mix(warm, cold, (ff - 3) / 5f);
                            Beam(x + dx * r1, y + dy * r1, cz + dz * r1 - g1, x + dx * r2, y + dy * r2, cz + dz * r2 - g2, c, ff < 4 ? 2.2f : 1.4f, F * 1.4f);
                        }
                    });
                }
                Frame(0, owner, () => Circle(x, y, cz, 10f, 10, hot, 3f, 0.08f));
                break;
            }
            case "bolt": // разряд: два мерцающих удара молнии с неба и электрическая волна по земле
            {
                Color blue = Color.FromArgb(255, 56, 211, 255), pale = Color.FromArgb(255, 190, 240, 255);
                void Strike(float life)
                {
                    const int seg = 9;
                    float px = x + (rnd.NextSingle() - 0.5f) * 60f, py = y + (rnd.NextSingle() - 0.5f) * 60f, pz = z + 560f;
                    for (var i = 1; i <= seg; i++)
                    {
                        var last = i == seg;
                        float nx = last ? x : x + (rnd.NextSingle() - 0.5f) * 50f, ny = last ? y : y + (rnd.NextSingle() - 0.5f) * 50f, nz = z + 560f - 555f * i / seg;
                        Beam(px, py, pz, nx, ny, nz, blue, 5f, life);
                        Beam(px, py, pz, nx, ny, nz, Color.White, 1.4f, life);
                        if (i is 3 or 6) { var (bx, by, _) = RandomDir(rnd); Beam(nx, ny, nz, nx + bx * 60f, ny + by * 60f, nz - 70f, pale, 1.6f, life); }
                        px = nx; py = ny; pz = nz;
                    }
                }
                Frame(0, owner, () => Strike(0.12f));
                Frame(0.16f, owner, () => Strike(0.2f));
                for (var f = 0; f < 7; f++)
                {
                    var ff = f;
                    Frame(0.18f + ff * F, owner, () =>
                    {
                        var r = 12f + ff * 11f;
                        for (var i = 0; i < 8; i++)
                        {
                            var a = i * MathF.Tau / 8f + ff * 0.3f;
                            float jx = MathF.Cos(a + 0.25f) * (r + 6f), jy = MathF.Sin(a + 0.25f) * (r + 6f);
                            Beam(x + MathF.Cos(a) * r, y + MathF.Sin(a) * r, z + 3f, x + jx, y + jy, z + 3f, ff % 2 == 0 ? blue : Color.White, 2.2f, F * 1.3f);
                        }
                    });
                }
                break;
            }
            case "conf": // конфетти: хлопушка выстреливает вверх, кусочки кружатся и падают
            {
                const int n = 22;
                var p = Enumerable.Range(0, n).Select(_ =>
                {
                    var a = rnd.NextSingle() * MathF.Tau; var h = 0.35f + rnd.NextSingle() * 0.5f;
                    return (vx: MathF.Cos(a) * h * 9f, vy: MathF.Sin(a) * h * 9f, vz: 14f + rnd.NextSingle() * 8f, spin: rnd.NextSingle() * MathF.Tau);
                }).ToArray();
                for (var f = 0; f < 14; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        for (var i = 0; i < n; i++)
                        {
                            var q = p[i]; float t = ff;
                            float cx = x + q.vx * t, cy = y + q.vy * t, cz = z + 30f + q.vz * t - 1.6f * t * t;
                            if (cz < z + 2f) continue;
                            var ang = q.spin + ff * 0.9f;
                            Beam(cx, cy, cz, cx + MathF.Cos(ang) * 5f, cy + MathF.Sin(ang) * 5f, cz + MathF.Sin(ang * 1.7f) * 3f, Palette[i % Palette.Length], 2.8f, F * 1.3f);
                        }
                    });
                }
                break;
            }
            case "ring": // золотое кольцо: три ударные волны расходятся от тела, в центре поднимается столб света
            {
                Color gold = Color.FromArgb(255, 245, 196, 81), pale = Color.FromArgb(255, 255, 236, 170);
                for (var w = 0; w < 3; w++)
                    for (var f = 0; f < 8; f++)
                    {
                        var ff = f; var ww = w;
                        Frame(ww * 0.14f + ff * F, owner, () => Circle(x, y, z + 4f + ww * 2f, 10f + ff * 9f, 16, Mix(pale, gold, ff / 7f), ff < 4 ? 3.2f : 2f, F * 1.3f));
                    }
                for (var f = 0; f < 6; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () => { var h = 30f + ff * 30f; Beam(x, y, z + 4f, x, y, z + h, gold, 4f - ff * 0.4f, ff == 5 ? 0.5f : F * 1.3f); Beam(x, y, z + 4f, x, y, z + h, Color.White, 1.2f, ff == 5 ? 0.5f : F * 1.3f); });
                }
                break;
            }
            case "frost": // снежинка: шесть ледяных лучей прорастают по земле, на них вырастают ветки, сверху сыплет снег
            {
                Color ice = Color.FromArgb(255, 125, 211, 252), white = Color.FromArgb(255, 235, 248, 255);
                float gz = z + 4f;
                for (var f = 1; f <= 6; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        float r0 = (ff - 1) * 8f, r1 = ff * 8f, life = 1.1f - ff * F;
                        for (var i = 0; i < 6; i++)
                        {
                            var a = i * MathF.PI / 3f; float cx = MathF.Cos(a), cy = MathF.Sin(a);
                            Beam(x + cx * r0, y + cy * r0, gz, x + cx * r1, y + cy * r1, gz, ice, 2.8f, life);
                            if (ff is 3 or 5)
                                foreach (var sgn in new[] { -1f, 1f })
                                {
                                    var b = a + sgn * 0.75f; var l = ff == 3 ? 13f : 9f;
                                    Beam(x + cx * r1, y + cy * r1, gz, x + cx * r1 + MathF.Cos(b) * l, y + cy * r1 + MathF.Sin(b) * l, gz, white, 1.5f, life);
                                }
                        }
                    });
                }
                Frame(0.35f, owner, () => Circle(x, y, gz, 52f, 18, white, 1.2f, 0.7f));
                var flakes = Enumerable.Range(0, 12).Select(_ => (a: rnd.NextSingle() * MathF.Tau, r: rnd.NextSingle() * 46f, h: 70f + rnd.NextSingle() * 60f)).ToArray();
                for (var f = 0; f < 12; f++)
                {
                    var ff = f;
                    Frame(0.1f + ff * F, owner, () =>
                    {
                        foreach (var q in flakes)
                        {
                            float pz = z + q.h - ff * 7f; if (pz < gz) continue;
                            float px = x + MathF.Cos(q.a) * q.r + MathF.Sin(ff * 0.7f + q.a) * 4f, py = y + MathF.Sin(q.a) * q.r;
                            Beam(px, py, pz, px, py, pz - 4f, Color.White, 2.4f, F * 1.3f);
                        }
                    });
                }
                break;
            }
            case "fire": // пламя: языки огня колышутся и поднимаются, от жёлтого у земли к красному сверху, вылетают искры
            {
                Color core = Color.FromArgb(255, 255, 236, 140), mid = Color.FromArgb(255, 255, 150, 40), top = Color.FromArgb(255, 235, 60, 30);
                var tongues = Enumerable.Range(0, 10).Select(i => (a: MathF.Tau * i / 10f + rnd.NextSingle() * 0.4f, r: 6f + rnd.NextSingle() * 16f, h: 70f + rnd.NextSingle() * 50f, ph: rnd.NextSingle() * 6f)).ToArray();
                for (var f = 0; f < 14; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        var grow = MathF.Min(1f, ff / 4f) * (ff > 10 ? 1f - (ff - 10) / 4f : 1f);
                        foreach (var q in tongues)
                        {
                            float bx = x + MathF.Cos(q.a) * q.r, by = y + MathF.Sin(q.a) * q.r, h = q.h * grow;
                            const int seg = 4; float px = bx, py = by, pz = z + 2f;
                            for (var s = 1; s <= seg; s++)
                            {
                                float t = (float)s / seg, sway = MathF.Sin(ff * 0.8f + q.ph + t * 3f) * 7f * t;
                                float nx = bx + (x - bx) * t * 0.7f + MathF.Cos(q.a + 1.57f) * sway, ny = by + (y - by) * t * 0.7f + MathF.Sin(q.a + 1.57f) * sway, nz = z + 2f + h * t;
                                Beam(px, py, pz, nx, ny, nz, t < 0.5f ? Mix(core, mid, t * 2f) : Mix(mid, top, (t - 0.5f) * 2f), 5f * (1.1f - t), F * 1.3f);
                                px = nx; py = ny; pz = nz;
                            }
                        }
                        if (ff % 2 == 0)
                            for (var i = 0; i < 3; i++)
                            {
                                var ang = rnd.NextSingle() * MathF.Tau; var rad = rnd.NextSingle() * 22f; float ex = x + MathF.Cos(ang) * rad, ey = y + MathF.Sin(ang) * rad, ez = z + 40f + rnd.NextSingle() * 80f;
                                Beam(ex, ey, ez, ex, ey, ez + 6f, core, 1.6f, 0.15f);
                            }
                    });
                }
                break;
            }
            case "tornado": // вихрь: зелёная воронка вращается и растёт вверх
            {
                Color lime = Color.FromArgb(255, 181, 232, 83), pale = Color.FromArgb(255, 230, 255, 190);
                for (var f = 0; f < 14; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        float height = MathF.Min(170f, 40f + ff * 18f), phase = ff * 0.55f;
                        for (var arm = 0; arm < 2; arm++)
                        {
                            const int n = 12;
                            float a0 = phase + arm * MathF.PI, px = x + MathF.Cos(a0) * 8f, py = y + MathF.Sin(a0) * 8f, pz = z + 2f;
                            for (var i = 1; i <= n; i++)
                            {
                                float t = (float)i / n, ang = a0 + t * MathF.Tau * 1.6f, rad = 8f + t * 46f;
                                float nx = x + MathF.Cos(ang) * rad, ny = y + MathF.Sin(ang) * rad, nz = z + 2f + t * height;
                                Beam(px, py, pz, nx, ny, nz, arm == 0 ? lime : Mix(lime, pale, t), arm == 0 ? 2.6f : 1.4f, F * 1.3f);
                                px = nx; py = ny; pz = nz;
                            }
                        }
                    });
                }
                Frame(0, owner, () => Circle(x, y, z + 3f, 30f, 14, lime, 1.6f, 0.7f));
                break;
            }
            case "star": // звезда: контур рисуется по лучу, вспыхивает и выпускает столб света
            {
                Color gold = Color.FromArgb(255, 255, 207, 64), pale = Color.FromArgb(255, 255, 244, 200);
                float gz = z + 4f;
                (float X, float Y) P(int i, float s) { var a = -MathF.PI / 2f + i * MathF.PI / 5f; var r = (i % 2 == 0 ? 52f : 21f) * s; return (x + MathF.Cos(a) * r, y + MathF.Sin(a) * r); }
                for (var i = 0; i < 10; i++)
                {
                    var ii = i;
                    Frame(ii * 0.035f, owner, () => { var (ax, ay) = P(ii, 1f); var (bx, by) = P(ii + 1, 1f); Beam(ax, ay, gz, bx, by, gz, gold, 3.2f, 1.1f - ii * 0.035f); });
                }
                for (var f = 0; f < 6; f++)
                {
                    var ff = f;
                    Frame(0.38f + ff * F, owner, () =>
                    {
                        var sc = 1f + ff * 0.16f;
                        for (var i = 0; i < 10; i++) { var (ax, ay) = P(i, sc); var (bx, by) = P(i + 1, sc); Beam(ax, ay, gz + 1f, bx, by, gz + 1f, Mix(pale, gold, ff / 5f), 2f - ff * 0.25f, F * 1.3f); }
                        var h = 40f + ff * 26f; Beam(x, y, gz, x, y, z + h, gold, 3.5f, ff == 5 ? 0.45f : F * 1.3f); Beam(x, y, gz, x, y, z + h, Color.White, 1f, ff == 5 ? 0.45f : F * 1.3f);
                    });
                }
                break;
            }
            case "rainbow": // радуга: дуга вырастает от одного края до другого и держится
            {
                Color[] rb = { Color.FromArgb(255, 255, 80, 80), Color.FromArgb(255, 255, 160, 60), Color.FromArgb(255, 255, 230, 80),
                               Color.FromArgb(255, 120, 230, 100), Color.FromArgb(255, 70, 170, 255), Color.FromArgb(255, 160, 100, 255) };
                var dir = rnd.NextSingle() * MathF.Tau; float ux = MathF.Cos(dir), uy = MathF.Sin(dir);
                const int seg = 10;
                for (var i = 0; i < seg; i++)
                {
                    var ii = i;
                    Frame(ii * 0.04f, owner, () =>
                    {
                        float a1 = MathF.PI * ii / seg, a2 = MathF.PI * (ii + 1) / seg;
                        for (var k = 0; k < rb.Length; k++)
                        {
                            var r = 72f - k * 6f;
                            Beam(x + ux * MathF.Cos(a1) * r, y + uy * MathF.Cos(a1) * r, z + 4f + MathF.Sin(a1) * r,
                                 x + ux * MathF.Cos(a2) * r, y + uy * MathF.Cos(a2) * r, z + 4f + MathF.Sin(a2) * r, rb[k], 3.4f, 1.2f - ii * 0.04f);
                        }
                    });
                }
                Frame(0.4f, owner, () => { foreach (var e in new[] { -1f, 1f }) Circle(x + ux * 69f * e, y + uy * 69f * e, z + 3f, 10f, 8, Color.White, 1.4f, 0.6f); });
                break;
            }
            case "nova": // сверхновая: свет стягивается в точку и взрывается лучами во все стороны
            {
                Color[] cols = { Color.FromArgb(255, 200, 90, 255), Color.FromArgb(255, 255, 90, 200), Color.White };
                float cz = z + 40f;
                for (var f = 0; f < 4; f++) { var ff = f; Frame(ff * F, owner, () => Circle(x, y, cz, 56f - ff * 14f, 14, cols[ff % 2], 2.4f, F * 1.3f)); }
                var dirs = Enumerable.Range(0, 20).Select(_ => RandomDir(rnd)).ToArray();
                for (var f = 0; f < 7; f++)
                {
                    var ff = f;
                    Frame(0.2f + ff * F, owner, () =>
                    {
                        for (var i = 0; i < dirs.Length; i++)
                        {
                            var (dx, dy, dz) = dirs[i]; float r1 = 4f + ff * 12f, r2 = r1 + 18f + ff * 3f;
                            Beam(x + dx * r1, y + dy * r1, cz + dz * r1, x + dx * r2, y + dy * r2, cz + dz * r2, cols[i % cols.Length], i % 3 == 2 ? 1.2f : 2.6f, F * 1.3f);
                        }
                        Circle(x, y, cz, 8f + ff * 13f, 16, cols[0], 2.2f - ff * 0.2f, F * 1.3f);
                    });
                }
                Frame(0.2f, owner, () => Circle(x, y, cz, 6f, 8, Color.White, 5f, 0.1f));
                break;
            }
            case "storm": // снежная буря (эксклюзив Winter Ops): ледяная воронка вращается, по земле расходится иней, кружит снег
            {
                Color[] cols = { Color.FromArgb(255, 159, 220, 255), Color.FromArgb(255, 94, 240, 200), Color.FromArgb(255, 232, 247, 255) };
                float gz = z + 4f;
                var flakes = Enumerable.Range(0, 16).Select(_ => (a: rnd.NextSingle() * MathF.Tau, r: 14f + rnd.NextSingle() * 50f, h: 15f + rnd.NextSingle() * 110f)).ToArray();
                for (var f = 0; f < 16; f++)
                {
                    var ff = f;
                    Frame(ff * F, owner, () =>
                    {
                        float phase = ff * 0.5f, height = MathF.Min(120f, 30f + ff * 14f);
                        for (var arm = 0; arm < 3; arm++)
                        {
                            const int n = 9;
                            float a0 = phase + arm * MathF.Tau / 3f, px = x + MathF.Cos(a0) * 12f, py = y + MathF.Sin(a0) * 12f, pz = gz;
                            for (var i = 1; i <= n; i++)
                            {
                                float t = (float)i / n, ang = a0 + t * MathF.Tau * 1.2f, rad = 12f + t * 40f;
                                float nx = x + MathF.Cos(ang) * rad, ny = y + MathF.Sin(ang) * rad, nz = gz + t * height;
                                Beam(px, py, pz, nx, ny, nz, cols[arm], 2.2f, F * 1.3f);
                                px = nx; py = ny; pz = nz;
                            }
                        }
                        foreach (var q in flakes)
                        {
                            float ang = q.a + ff * 0.35f, pz = z + q.h - ff * 3f; if (pz < gz) continue;
                            float px = x + MathF.Cos(ang) * q.r, py = y + MathF.Sin(ang) * q.r;
                            Beam(px, py, pz, px + MathF.Cos(ang + 1.57f) * 4f, py + MathF.Sin(ang + 1.57f) * 4f, pz - 2f, Color.White, 2.2f, F * 1.3f);
                        }
                        if (ff % 4 == 0) Circle(x, y, gz, 20f, 14, cols[1], 2.2f, 0.25f);
                        if (ff % 4 == 2) Circle(x, y, gz, 50f, 18, cols[0], 1.6f, 0.25f);
                    });
                }
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

    // --- след гранаты: каждые 7 тиков луч от прошлой точки до текущей; видят бросивший и наблюдающие за ним ---
    private void StartTrail(CBaseCSGrenadeProjectile g, Color c, ulong owner)
    {
        if (g.AbsOrigin is not { } o || _trails.Count >= 32) return;
        _trails.Add(new GrenadeTrail { G = g, C = c, Owner = owner, X = o.X, Y = o.Y, Z = o.Z });
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
            Frame(0, t.Owner, () => Beam(t.X, t.Y, t.Z, o.X, o.Y, o.Z, t.C, 1.6f, 0.35f)); // след видят бросивший и наблюдающие за ним
            t.X = o.X; t.Y = o.Y; t.Z = o.Z;
        }
    }
}
