// Особые раунды и звуки серий убийств.
// Особый раунд — раз в 2–3 раунда (не в разминку, не в пистолетный и не в овертайм). Режимы двух видов:
//  • одинаковое оружие у всех (ножи, Deagle, AWP, скауты, Zeus, 1 HP, гранаты, невидимки с ножами) — закупка и подбор чужого запрещены;
//  • правило поверх обычной игры (все с ВХ, только в голову, распрыжка, вампиры, бесконечные патроны) — закупка как обычно.
// Итог раунда плагин пишет в консоль строкой «TASHERFUN special_win <режим> <ct|t>» — сайт читает журнал и начисляет ТК победителям.
// UPD: дополнительных звуков в игре нет (ни серий, ни начала особого раунда) — слышен только купленный звук убийства (Effects.cs).
// Первая кровь и эйс по-прежнему дают ТК и опыт пропуска — их считает сайт по журналу (server/lib/fun.js).
using System.Drawing;
using System.Globalization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    // Allow — номера предметов (item definition index), которые можно держать и подбирать, кроме ножа, бомбы, брони и щипцов.
    // Free — оружие обычное (закупка разрешена), режим меняет только правила.
    private sealed record SpecialMode(string Name, string Hint, string[] Give, ushort[] Allow, bool Armor, int Hp = 0, float Gravity = 0f, bool Free = false, string NeedCvar = "");

    private static readonly Dictionary<string, SpecialMode> SpecialModes = new()
    {
        ["knife"] = new("Только ножи", "закупки нет, у всех только нож", Array.Empty<string>(), Array.Empty<ushort>(), false),
        ["deagle"] = new("Дуэль на Deagle", "у всех Desert Eagle и броня", new[] { "weapon_deagle" }, new ushort[] { 1 }, true),
        ["awp"] = new("Только AWP", "у всех AWP и броня", new[] { "weapon_awp" }, new ushort[] { 9 }, true),
        ["scout"] = new("Скауты в низкой гравитации", "у всех SSG 08, гравитация снижена", new[] { "weapon_ssg08" }, new ushort[] { 40 }, true, 0, 300f),
        ["zeus"] = new("Только Zeus", "у всех Zeus и нож", new[] { "weapon_taser" }, new ushort[] { 31 }, false),
        ["onehp"] = new("1 HP: пистолеты", "у всех P250 и 1 HP — любое попадание смертельно", new[] { "weapon_p250" }, new ushort[] { 36 }, false, 1),
        ["nades"] = new("Война гранат", "у всех бесконечные HE-гранаты и броня", new[] { "weapon_hegrenade" }, new ushort[] { 44 }, true),
        ["invis"] = new("Невидимки", "все почти невидимы, у всех только нож — слушай шаги", Array.Empty<string>(), Array.Empty<ushort>(), false),
        ["wh"] = new("Все с ВХ", "все видят всех сквозь стены, оружие обычное", Array.Empty<string>(), Array.Empty<ushort>(), false, Free: true),
        ["hs"] = new("Только в голову", "урон проходит только в голову, оружие обычное", Array.Empty<string>(), Array.Empty<ushort>(), false, Free: true, NeedCvar: "mp_damage_headshot_only"),
        ["bhop"] = new("Распрыжка", "зажми пробел — прыжки сами, оружие обычное", Array.Empty<string>(), Array.Empty<ushort>(), false, Free: true, NeedCvar: "sv_autobunnyhopping"),
        ["vampire"] = new("Вампиры", "нанесённый урон лечит тебя (до 150 HP), оружие обычное", Array.Empty<string>(), Array.Empty<ushort>(), false, Free: true),
        ["ammo"] = new("Бесконечные патроны", "перезаряжаться не нужно, оружие обычное", Array.Empty<string>(), Array.Empty<ushort>(), false, Free: true),
    };
    private const ushort DefC4 = 49, DefHe = 44;
    private static readonly ushort[] AlwaysAllowed = { DefC4, 50, 51, 55 }; // бомба, броня, броня со шлемом, щипцы
    private static bool IsKnifeDef(ushort d) => d is 41 or 42 or 59 or 80 || d is >= 500 and < 600;
    private static bool AllowedIn(SpecialMode m, ushort d) => m.Free || IsKnifeDef(d) || Array.IndexOf(AlwaysAllowed, d) >= 0 || Array.IndexOf(m.Allow, d) >= 0;

    private SpecialMode? _special;
    private string _specialKind = "", _lastSpecial = "";
    private string? _forcedSpecial;
    private DateTime _specialAt;
    private int _sinceSpecial, _specialGap = 2;
    private bool _acqHooked;
    private readonly Dictionary<string, string> _cvarOrig = new();
    private readonly Dictionary<int, (CBaseModelEntity R, CBaseModelEntity G)> _glows = new();
    private readonly HashSet<int> _resetNext = new(); // кто дожил до конца особого раунда — в следующем раунде забираем «подарочное» оружие
    private CCSGameRulesProxy? _rulesProxy;

    private void LoadFun()
    {
        _specialGap = NextGap();
        RegisterEventHandler<EventRoundStart>(FunRoundStart);
        RegisterEventHandler<EventRoundFreezeEnd>((_, _) => { if (_special is { Free: false }) foreach (var p in Utilities.GetPlayers()) ArmPlayer(p, false); return HookResult.Continue; });
        RegisterEventHandler<EventRoundEnd>(FunRoundEnd);
        RegisterEventHandler<EventPlayerDeath>(FunPlayerDeath);
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            // зашёл посреди особого раунда — выдаём то же, что у всех
            if (_special != null && (DateTime.UtcNow - _specialAt).TotalSeconds > 1 && e.Userid is { IsValid: true } p)
            { var slot = p.Slot; AddTimer(0.3f, () => { var x = Utilities.GetPlayerFromSlot(slot); if (x != null) ArmPlayer(x, true); }, TimerFlags.STOP_ON_MAPCHANGE); }
            return HookResult.Continue;
        });
        RegisterEventHandler<EventItemPickup>((e, _) =>
        {
            // запасной вариант, если запрет через игру недоступен: подобрал чужое — отбираем
            if (_special is { Free: false } m && e.Userid is { IsValid: true } p && e.Defindex is >= 0 and <= ushort.MaxValue && !AllowedIn(m, (ushort)e.Defindex))
            { var slot = p.Slot; AddTimer(0.1f, () => { var x = Utilities.GetPlayerFromSlot(slot); if (x != null) ArmPlayer(x, false); }, TimerFlags.STOP_ON_MAPCHANGE); }
            return HookResult.Continue;
        });
        RegisterEventHandler<EventGrenadeThrown>((e, _) =>
        {
            // «Война гранат»: бросил — через секунду новая
            if (_specialKind == "nades" && e.Userid is { IsValid: true } p && e.Weapon == "hegrenade")
            {
                var slot = p.Slot;
                AddTimer(1.0f, () =>
                {
                    var x = Utilities.GetPlayerFromSlot(slot);
                    if (_specialKind != "nades" || x is not { IsValid: true } || !IsAlive(x) || Has(x, DefHe)) return;
                    x.GiveNamedItem("weapon_hegrenade");
                }, TimerFlags.STOP_ON_MAPCHANGE);
            }
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerHurt>((e, _) =>
        {
            // «Вампиры»: нанесённый урон возвращается здоровьем
            if (_specialKind != "vampire" || e.DmgHealth <= 0) return HookResult.Continue;
            var a = e.Attacker; var v = e.Userid;
            if (a is not { IsValid: true } || v is not { IsValid: true } || a.Slot == v.Slot || a.Team == v.Team || !IsAlive(a)) return HookResult.Continue;
            var pawn = a.PlayerPawn.Value!;
            var hp = Math.Min(150, pawn.Health + e.DmgHealth);
            if (hp > pawn.Health) { pawn.Health = hp; Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth"); }
            return HookResult.Continue;
        });
        RegisterEventHandler<EventWeaponFire>((e, _) =>
        {
            // «Бесконечные патроны»: после выстрела возвращаем патрон в магазин
            if (_specialKind != "ammo" || e.Userid is not { IsValid: true } p) return HookResult.Continue;
            var w = p.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value;
            if (w is not { IsValid: true }) return HookResult.Continue;
            var n = w.DesignerName;
            if (n.Contains("knife") || n.Contains("bayonet") || n.Contains("grenade") || n.Contains("flashbang") || n.Contains("molotov") || n.Contains("decoy") || n.Contains("taser") || n.Contains("c4")) return HookResult.Continue;
            Server.NextFrame(() =>
            {
                if (_specialKind != "ammo" || !w.IsValid) return;
                w.Clip1 += 1; Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_iClip1");
            });
            return HookResult.Continue;
        });
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _glows.Clear(); // сущности прошлой карты уже удалены
            RestoreSpecial(); _forcedSpecial = null; _resetNext.Clear(); _sinceSpecial = 0; _specialGap = NextGap(); _rulesProxy = null;
        });
        AddCommand("css_special", "Следующий раунд — особый: css_special <режим|random|off>", CmdSpecial);
        // запрет закупки и подбора чужого оружия на время особого раунда
        // перехват подбора предметов нужен только особым раундам; когда они выключены — не трогаем закупку и подбор вовсе
        // (лишний перехват мог сбивать иконку бомбы у игроков)
        if (!Config.FunEnabled) return;
        try { VirtualFunctions.CCSPlayer_ItemServices_CanAcquireFunc.Hook(OnCanAcquire, HookMode.Pre); _acqHooked = true; }
        catch (Exception ex) { Logger.LogWarning("Особые раунды: запрет закупки недоступен ({Err}) — лишнее оружие будет отбираться после закупки", ex.Message); }
    }

    public override void Unload(bool hotReload)
    {
        RestoreSpecial();
        if (_acqHooked) { try { VirtualFunctions.CCSPlayer_ItemServices_CanAcquireFunc.Unhook(OnCanAcquire, HookMode.Pre); } catch { } _acqHooked = false; }
    }

    private int NextGap()
    {
        int a = Math.Clamp(Config.SpecialEveryMin, 1, 50), b = Math.Clamp(Config.SpecialEveryMax, a, 50);
        return Random.Shared.Next(a, b + 1);
    }

    private CCSGameRules? Rules()
    {
        try
        {
            if (_rulesProxy is not { IsValid: true })
                _rulesProxy = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault();
            return _rulesProxy?.GameRules;
        }
        catch { return null; }
    }

    private static bool IsAlive(CCSPlayerController p)
    {
        var pawn = p.PlayerPawn.Value;
        return pawn is { IsValid: true } && pawn.LifeState == (byte)LifeState_t.LIFE_ALIVE;
    }

    private static bool Has(CCSPlayerController p, ushort def)
    {
        var ws = p.PlayerPawn.Value?.WeaponServices;
        if (ws == null) return false;
        foreach (var h in ws.MyWeapons) { var w = h.Value; if (w is { IsValid: true } && w.AttributeManager.Item.ItemDefinitionIndex == def) return true; }
        return false;
    }

    private static int ConInt(string name, int def)
    {
        try { var c = ConVar.Find(name); if (c == null) return def; int v = c.GetPrimitiveValue<int>(); return v; } catch { return def; }
    }

    // текущее значение квара строкой (для возврата после раунда)
    private static string? ReadCvar(string name)
    {
        try
        {
            var c = ConVar.Find(name); if (c == null) return null;
            switch (c.Type.ToString())
            {
                case "Bool": { bool v = c.GetPrimitiveValue<bool>(); return v ? "1" : "0"; }
                case "Int32": { int v = c.GetPrimitiveValue<int>(); return v.ToString(CultureInfo.InvariantCulture); }
                case "Float32": { float v = c.GetPrimitiveValue<float>(); return v.ToString(CultureInfo.InvariantCulture); }
                default: return null;
            }
        }
        catch { return null; }
    }

    private void SetCvar(string name, string value, string fallback)
    {
        if (!_cvarOrig.ContainsKey(name))
        {
            var cur = ReadCvar(name);
            _cvarOrig[name] = cur == null || cur == value ? fallback : cur;
        }
        Server.ExecuteCommand($"{name} {value}");
    }

    private static int HumansInTeams() => Utilities.GetPlayers().Count(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.Team is CsTeam.Terrorist or CsTeam.CounterTerrorist);

    private static bool ModeReady(SpecialMode m) => m.NeedCvar.Length == 0 || ConVar.Find(m.NeedCvar) != null;

    // ---------- начало раунда: решаем, особый ли он ----------
    private HookResult FunRoundStart(EventRoundStart e, GameEventInfo info)
    {
        RestoreSpecial();
        var rules = Rules();
        if (rules == null || rules.WarmupPeriod) return HookResult.Continue;
        // забрать у выживших оружие прошлого особого раунда
        if (_resetNext.Count > 0)
        {
            var slots = _resetNext.ToArray(); _resetNext.Clear();
            AddTimer(0.2f, () => { if (_special is { Free: false }) return; foreach (var s in slots) { var p = Utilities.GetPlayerFromSlot(s); if (p != null) ResetLoadout(p); } }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        if (!Config.FunEnabled) return HookResult.Continue;
        int round = rules.TotalRoundsPlayed + 1, max = ConInt("mp_maxrounds", 24), half = max / 2;
        _sinceSpecial++;
        string? kind = null;
        if (_forcedSpecial != null) { kind = _forcedSpecial; _forcedSpecial = null; }
        else if (round != 1 && round != half + 1 && (max <= 0 || round <= max) && _sinceSpecial >= _specialGap && HumansInTeams() >= Math.Max(1, Config.SpecialMinHumans))
        {
            var all = Config.SpecialModes.Where(k => SpecialModes.TryGetValue(k, out var x) && ModeReady(x)).Distinct().ToList();
            var pool = all.Where(k => k != _lastSpecial).ToList();
            if (pool.Count == 0) pool = all;
            if (pool.Count > 0) kind = pool[Random.Shared.Next(pool.Count)];
        }
        if (kind == null || !SpecialModes.TryGetValue(kind, out var m)) return HookResult.Continue;
        _sinceSpecial = 0; _specialGap = NextGap(); _lastSpecial = kind;
        StartSpecial(kind, m);
        return HookResult.Continue;
    }

    private void StartSpecial(string kind, SpecialMode m)
    {
        _special = m; _specialKind = kind; _specialAt = DateTime.UtcNow;
        if (m.Gravity > 0) SetCvar("sv_gravity", m.Gravity.ToString(CultureInfo.InvariantCulture), "800");
        if (kind == "hs") SetCvar("mp_damage_headshot_only", "1", "0");
        if (kind == "bhop") { SetCvar("sv_autobunnyhopping", "1", "0"); SetCvar("sv_enablebunnyhopping", "1", "0"); }
        Server.PrintToChatAll($"{Prefix}{ChatColors.Gold}ОСОБЫЙ РАУНД: {m.Name}!{ChatColors.Default} {m.Hint}. Победившей команде — бонус ТК");
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false, IsHLTV: false }) p.PrintToCenter($"ОСОБЫЙ РАУНД: {m.Name}");
        // UPD: без звука начала особого раунда — объявление только в чате и по центру экрана.
        AddTimer(0.3f, () => { if (_special == m) foreach (var p in Utilities.GetPlayers()) ArmPlayer(p, true); }, TimerFlags.STOP_ON_MAPCHANGE);
        Logger.LogInformation("Особый раунд: {Kind}", kind);
    }

    // выдать оружие и свойства режима; force — заново, иначе только если есть лишнее или не хватает нужного
    private void ArmPlayer(CCSPlayerController p, bool force)
    {
        if (_special is not { } m || p is not { IsValid: true } || p.IsHLTV) return;
        if (p.Team is not (CsTeam.Terrorist or CsTeam.CounterTerrorist) || !IsAlive(p)) return;
        var pawn = p.PlayerPawn.Value!;
        if (!m.Free)
        {
            bool hasC4 = false, extra = false;
            var have = new HashSet<ushort>();
            var ws = pawn.WeaponServices;
            if (ws != null)
                foreach (var h in ws.MyWeapons)
                {
                    var w = h.Value; if (w is not { IsValid: true }) continue;
                    var d = w.AttributeManager.Item.ItemDefinitionIndex;
                    if (d == DefC4) hasC4 = true; else if (!AllowedIn(m, d)) extra = true; else have.Add(d);
                }
            var missing = m.Allow.Any(a => !have.Contains(a)) && _specialKind != "nades"; // гранаты бросают — их отсутствие не повод всё перевыдавать
            if (force || extra || missing)
            {
                p.RemoveWeapons();
                p.GiveNamedItem(p.Team == CsTeam.Terrorist ? "weapon_knife_t" : "weapon_knife");
                foreach (var g in m.Give) p.GiveNamedItem(g);
                if (hasC4) p.GiveNamedItem("weapon_c4");
            }
            if (force && m.Armor) p.GiveNamedItem("item_assaultsuit");
        }
        if (m.Hp > 0)
        {
            pawn.Health = m.Hp; Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
            pawn.ArmorValue = 0; Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
        }
        if (!force) return;
        if (_specialKind == "invis") SetAlpha(pawn, 25);
        if (_specialKind == "wh") AddGlow(p);
    }

    private static void SetAlpha(CCSPlayerPawn pawn, int alpha)
    {
        try
        {
            pawn.RenderMode = alpha >= 255 ? RenderMode_t.kRenderNormal : RenderMode_t.kRenderTransAlpha;
            pawn.Render = Color.FromArgb(alpha, 255, 255, 255);
            Utilities.SetStateChanged(pawn, "CBaseModelEntity", "m_nRenderMode");
            Utilities.SetStateChanged(pawn, "CBaseModelEntity", "m_clrRender");
        }
        catch { }
    }

    // «ВХ»: светящаяся копия модели игрока, видна всем сквозь стены
    private void AddGlow(CCSPlayerController p)
    {
        RemoveGlow(p.Slot);
        try
        {
            var pawn = p.PlayerPawn.Value; if (pawn is not { IsValid: true }) return;
            var model = pawn.CBodyComponent?.SceneNode?.GetSkeletonInstance().ModelState.ModelName ?? "";
            if (model.Length == 0) return;
            var r = Utilities.CreateEntityByName<CBaseModelEntity>("prop_dynamic");
            var g = Utilities.CreateEntityByName<CBaseModelEntity>("prop_dynamic");
            if (r == null || g == null) { r?.Remove(); g?.Remove(); return; }
            r.SetModel(model); r.Spawnflags = 256u; r.RenderMode = RenderMode_t.kRenderNone; r.DispatchSpawn();
            g.SetModel(model); g.Spawnflags = 256u; g.RenderMode = RenderMode_t.kRenderTransAlpha; g.Render = Color.FromArgb(1, 255, 255, 255); g.DispatchSpawn();
            g.Glow.GlowColorOverride = p.Team == CsTeam.Terrorist ? Color.FromArgb(255, 255, 170, 60) : Color.FromArgb(255, 90, 170, 255);
            g.Glow.GlowRange = 5000; g.Glow.GlowRangeMin = 20; g.Glow.GlowTeam = -1; g.Glow.GlowType = 3;
            r.AcceptInput("FollowEntity", pawn, r, "!activator");
            g.AcceptInput("FollowEntity", r, g, "!activator");
            _glows[p.Slot] = (r, g);
        }
        catch (Exception ex) { Logger.LogWarning("ВХ-подсветка не создалась: {Err}", ex.Message); }
    }

    private void RemoveGlow(int slot)
    {
        if (!_glows.Remove(slot, out var e)) return;
        try { if (e.G.IsValid) e.G.Remove(); } catch { }
        try { if (e.R.IsValid) e.R.Remove(); } catch { }
    }

    // после особого раунда: у выживших — нож и обычный пистолет, без бесплатной брони
    private void ResetLoadout(CCSPlayerController p)
    {
        if (p is not { IsValid: true } || p.IsHLTV || p.Team is not (CsTeam.Terrorist or CsTeam.CounterTerrorist) || !IsAlive(p)) return;
        var hasC4 = Has(p, DefC4);
        p.RemoveWeapons();
        p.GiveNamedItem(p.Team == CsTeam.Terrorist ? "weapon_knife_t" : "weapon_knife");
        p.GiveNamedItem(p.Team == CsTeam.Terrorist ? "weapon_glock" : "weapon_usp_silencer");
        if (hasC4) p.GiveNamedItem("weapon_c4");
        var pawn = p.PlayerPawn.Value!;
        pawn.ArmorValue = 0; Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
    }

    private HookResult FunRoundEnd(EventRoundEnd e, GameEventInfo info)
    {
        if (_special == null) return HookResult.Continue;
        var team = e.Winner == 3 ? "ct" : e.Winner == 2 ? "t" : null;
        // строка для сайта (он начисляет ТК победителям и пишет в чат)
        if (team != null) Console.WriteLine($"TASHERFUN special_win {_specialKind} {team}");
        _resetNext.Clear();
        if (!_special.Free)
            foreach (var p in Utilities.GetPlayers())
                if (p is { IsValid: true, IsHLTV: false } && IsAlive(p)) _resetNext.Add(p.Slot);
        RestoreSpecial();
        return HookResult.Continue;
    }

    private void RestoreSpecial()
    {
        foreach (var (k, v) in _cvarOrig) Server.ExecuteCommand($"{k} {v}");
        _cvarOrig.Clear();
        foreach (var s in _glows.Keys.ToArray()) RemoveGlow(s);
        if (_specialKind == "invis")
            foreach (var p in Utilities.GetPlayers())
                if (p is { IsValid: true } && p.PlayerPawn.Value is { IsValid: true } pawn) SetAlpha(pawn, 255);
        _special = null; _specialKind = "";
    }

    private HookResult OnCanAcquire(DynamicHook h)
    {
        var m = _special;
        if (m == null || m.Free) return HookResult.Continue;
        try
        {
            var method = h.GetParam<AcquireMethod>(2);
            var d = h.GetParam<CEconItemView>(1).ItemDefinitionIndex;
            if (method == AcquireMethod.PickUp && AllowedIn(m, d)) return HookResult.Continue;
            h.SetReturn(AcquireResult.NotAllowedByProhibition);
            return HookResult.Stop;
        }
        catch { return HookResult.Continue; }
    }

    // css_special <режим|random|off> — с консоли сервера (RCON, админка сайта) или админом с @css/root
    private void CmdSpecial(CCSPlayerController? p, CommandInfo info)
    {
        if (p != null && !AdminManager.PlayerHasPermissions(p, "@css/root")) { info.ReplyToCommand("[TASHER] Нет доступа"); return; }
        var arg = info.ArgCount > 1 ? info.GetArg(1).Trim().ToLowerInvariant() : "random";
        if (arg == "off") { _forcedSpecial = null; info.ReplyToCommand("[TASHER] Особый раунд отменён"); return; }
        if (arg == "random")
        {
            // раньше при единственном доступном режиме (он же прошлый) список был пуст и команда падала
            var ready = SpecialModes.Where(x => ModeReady(x.Value)).Select(x => x.Key).ToList();
            var keys = ready.Where(k => k != _lastSpecial).ToList();
            if (keys.Count == 0) keys = ready;
            if (keys.Count == 0) { info.ReplyToCommand("[TASHER] На этом сервере нет доступных особых режимов"); return; }
            arg = keys[Random.Shared.Next(keys.Count)];
        }
        if (!SpecialModes.TryGetValue(arg, out var m)) { info.ReplyToCommand("[TASHER] Режимы: " + string.Join(", ", SpecialModes.Keys) + ", random, off"); return; }
        if (!ModeReady(m)) { info.ReplyToCommand($"[TASHER] Режим {arg} на этом сервере недоступен (нет квара {m.NeedCvar})"); return; }
        _forcedSpecial = arg;
        info.ReplyToCommand($"[TASHER] Следующий раунд — особый: {m.Name} ({arg})");
        Server.PrintToChatAll($"{Prefix}Следующий раунд — {ChatColors.Gold}особый: {m.Name}");
    }

    // ---------- смерть игрока ----------
    // UPD: звуки серий (первая кровь, двойное … эйс) отключены — слышен только купленный звук убийства из Effects.cs.
    private HookResult FunPlayerDeath(EventPlayerDeath e, GameEventInfo info)
    {
        if (e.Userid is { IsValid: true } v) RemoveGlow(v.Slot); // убитый больше не светится
        return HookResult.Continue;
    }
}
