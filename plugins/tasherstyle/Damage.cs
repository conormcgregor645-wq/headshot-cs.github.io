// Дамагер: при попадании по игроку у прицела всплывает, сколько урона нанесено.
// Цифра появляется в случайном месте вокруг прицела (не на нём самом), чуть поднимается и через ~0,8 с исчезает.
// Попадание в голову — жёлтая цифра, убийство — красная, остальное — белая. Видит только стрелок и те, кто за ним наблюдает.
// Выключить себе можно в !menu, всем — DamageEnabled в конфиге.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    private sealed class DmgNum { public CPointWorldText E = null!; public float X, Y, Born; }
    private readonly Dictionary<int, List<DmgNum>> _dmg = new(); // слот стрелка → его цифры
    private const float DmgLife = 0.8f;
    private const int DmgMax = 6; // больше цифр одновременно у одного игрока не держим

    private void LoadDamage()
    {
        RegisterEventHandler<EventPlayerHurt>(OnDamageHurt);
        RegisterListener<Listeners.OnTick>(DamageTick);
        RegisterListener<Listeners.CheckTransmit>(DamageTransmit);
        RegisterListener<Listeners.OnMapStart>(_ => _dmg.Clear());
    }

    private HookResult OnDamageHurt(EventPlayerHurt e, GameEventInfo info)
    {
        if (!Config.DamageEnabled) return HookResult.Continue;
        var a = e.Attacker; var v = e.Userid;
        if (a is not { IsValid: true } || a.IsBot || v is not { IsValid: true } || a == v || e.DmgHealth <= 0) return HookResult.Continue;
        if (!PrefOn(a.SteamID, OffDamage)) return HookResult.Continue;
        if (a.PlayerPawn.Value is not { IsValid: true } pawn || !a.PawnIsAlive) return HookResult.Continue;
        try
        {
            var color = e.Health <= 0 ? "#ff3b3b" : e.Hitgroup == 1 ? "#ffd23f" : "#ffffff";
            var ent = MakeText(e.DmgHealth.ToString(), color, 46);
            if (ent is null) return HookResult.Continue;
            // случайная точка в кольце вокруг прицела: не ближе 0,35 и не дальше 1,1 юнита (на расстоянии 9 юнитов от глаз)
            var ang = Random.Shared.NextSingle() * MathF.PI * 2;
            var r = 0.35f + Random.Shared.NextSingle() * 0.75f;
            var n = new DmgNum { E = ent, X = MathF.Cos(ang) * r, Y = MathF.Sin(ang) * r * 0.8f + 0.15f, Born = Server.CurrentTime };
            PlaceAt(ent, pawn, n.X, n.Y);
            ent.AcceptInput("SetParent", pawn, null, "!activator");
            if (!_dmg.TryGetValue(a.Slot, out var list)) _dmg[a.Slot] = list = new();
            list.Add(n);
            while (list.Count > DmgMax) { if (list[0].E.IsValid) list[0].E.Remove(); list.RemoveAt(0); }
        }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] дамагер: {Error}", ex.Message); }
        return HookResult.Continue;
    }

    private void DamageTick()
    {
        if (_dmg.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, list) in _dmg.ToList())
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            var alive = p is { IsValid: true, PawnIsAlive: true } && p.PlayerPawn.Value is { IsValid: true };
            for (var i = list.Count - 1; i >= 0; i--)
            {
                var n = list[i];
                var age = now - n.Born;
                if (!alive || !n.E.IsValid || age > DmgLife) { if (n.E.IsValid) n.E.Remove(); list.RemoveAt(i); continue; }
                PlaceAt(n.E, p!.PlayerPawn.Value!, n.X, n.Y + age * 0.5f); // цифра немного всплывает
            }
            if (list.Count == 0) _dmg.Remove(slot);
        }
    }

    private void DamageTransmit(CCheckTransmitInfoList infoList)
    {
        if (_dmg.Count == 0) return;
        foreach (var (info, viewer) in infoList)
        {
            if (viewer is not { IsValid: true }) continue;
            var target = viewer.PawnIsAlive ? null
                : viewer.PlayerPawn.Value?.ObserverServices?.ObserverTarget.Value ?? viewer.ObserverPawn.Value?.ObserverServices?.ObserverTarget.Value;
            foreach (var (slot, list) in _dmg)
            {
                if (slot == viewer.Slot) continue;
                var owner = Utilities.GetPlayerFromSlot(slot);
                if (target is { IsValid: true } && owner?.PlayerPawn.Value is { IsValid: true } op && op.Handle == target.Handle) continue;
                foreach (var n in list) if (n.E.IsValid) info.TransmitEntities.Remove(n.E);
            }
        }
    }
}
