// Автобаланс команд: в конце раунда, если в одной команде на BalanceDiff (2) живых людей больше, сервер переводит
// одного игрока в меньшую команду. Кого переводить: того, кого давно не переводили (не чаще раза в 5 раундов),
// с наименьшим счётом. Переход — в паузе между раундами, без смерти и без потери денег. Плюс mp_limitteams 1:
// при входе нельзя выбрать команду, где уже больше игроков. Выключить — AutoBalance: false в конфиге.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace TasherStyle;

public partial class TasherStyle
{
    private readonly Dictionary<ulong, int> _movedAt = new(); // кого и в каком раунде переводили
    private int _roundNo;

    private void LoadBalance()
    {
        RegisterListener<Listeners.OnMapStart>(_ => { _movedAt.Clear(); _roundNo = 0; AddTimer(3f, BalanceCvars, TimerFlags.STOP_ON_MAPCHANGE); });
        RegisterEventHandler<EventRoundStart>((_, _) => { _roundNo++; BalanceCvars(); return HookResult.Continue; });
        RegisterEventHandler<EventRoundEnd>((_, _) => { if (Config.AutoBalance) AddTimer(1.5f, Rebalance, TimerFlags.STOP_ON_MAPCHANGE); return HookResult.Continue; }, HookMode.Post);
        AddTimer(2f, BalanceCvars);
    }

    private void BalanceCvars()
    {
        if (Config.AutoBalance) Server.ExecuteCommand("mp_autoteambalance 0; mp_limitteams 1");
    }

    private void Rebalance()
    {
        var humans = Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.TeamNum is 2 or 3).ToList();
        var t = humans.Where(p => p.TeamNum == 2).ToList();
        var ct = humans.Where(p => p.TeamNum == 3).ToList();
        var diff = Math.Abs(t.Count - ct.Count);
        if (diff < Math.Max(2, Config.BalanceDiff)) return;
        var big = t.Count > ct.Count ? t : ct;
        var to = t.Count > ct.Count ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
        var who = big
            .Where(p => !_movedAt.TryGetValue(p.SteamID, out var r) || _roundNo - r >= 5)
            .OrderBy(p => p.PawnIsAlive ? 1 : 0)
            .ThenBy(p => p.Score)
            .FirstOrDefault() ?? big.OrderBy(p => p.Score).First();
        _movedAt[who.SteamID] = _roundNo;
        who.SwitchTeam(to);
        var side = to == CsTeam.CounterTerrorist ? $"{ChatColors.LightBlue}спецназ" : $"{ChatColors.Yellow}террористов";
        who.PrintToCenterHtml($"<font class='fontSize-l' color='#f5c451'>Автобаланс</font><br>Ты переведён за {(to == CsTeam.CounterTerrorist ? "спецназ" : "террористов")}", 4);
        Server.PrintToChatAll($"{Prefix}Автобаланс: {ChatColors.Lime}{who.PlayerName}{ChatColors.Default} переведён за {side}{ChatColors.Default} ({t.Count}:{ct.Count} → {(to == CsTeam.Terrorist ? t.Count + 1 : t.Count - 1)}:{(to == CsTeam.CounterTerrorist ? ct.Count + 1 : ct.Count - 1)}).");
    }
}
