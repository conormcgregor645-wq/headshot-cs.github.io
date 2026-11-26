// Свои модели оружия (пока — ножи). Как это работает в CS2 после обновления анимаций (AnimGraph2):
//  • в аддоне Мастерской лежит модель и СВОЙ scripts/weapons.vdata — копия игрового файла с добавленной записью
//    (например weapon_knife_rose), где указана наша модель. Игроки скачивают аддон — и игра знает эту запись,
//    поэтому модель видно и от первого лица, и со стороны;
//  • при возрождении плагин забирает у игрока обычное оружие этого слота, выдаёт Base (weapon_knife) и переключает
//    его на нашу запись: AcceptInput("ChangeSubclass", Vdata).
// Настройки — WeaponModels в конфиге (скрипт weapon-model-add.sh). Игрок надевает модель на сайте, выключает в !menu.
// Выдаём через 1,5 с после возрождения — позже, чем WeaponPaints выдаёт нож из инвентаря, иначе он его перебьёт.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    private void LoadWeaponModels()
    {
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            foreach (var w in Config.WeaponModels.Values)
                if (IsSafeModel(w.Model)) manifest.AddResource(w.Model);
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true, IsBot: false } && Config.WeaponModels.Count > 0)
                AddTimer(1.5f, () => ApplyWeaponModel(p), TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
    }

    private static bool IsSafeName(string s) => s.Length is > 3 and < 64 && s.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '_');

    private static bool InSlot(string designer, int slot) => slot switch
    {
        2 => designer.Contains("knife") || designer.Contains("bayonet"),
        _ => false,
    };

    private void ApplyWeaponModel(CCSPlayerController p)
    {
        if (!p.IsValid || !p.PawnIsAlive || p.PlayerPawn.Value is not { IsValid: true } pawn) return;
        var s = StyleOf(p);
        if (s is not { WModel.Length: > 0 } || !PrefOn(p.SteamID, OffWModel)) return;
        if (!Config.WeaponModels.TryGetValue(s.WModel, out var w) || !IsSafeName(w.Base) || !IsSafeName(w.Vdata)) return;
        if (w.Slot != 2) return; // пока поддерживаем только ножи: у них нет патронов и покупки
        try
        {
            var ws = pawn.WeaponServices;
            if (ws == null) return;
            foreach (var h in ws.MyWeapons)
            {
                var wpn = h.Value;
                if (wpn is not { IsValid: true }) continue;
                if (!InSlot(wpn.DesignerName, w.Slot)) continue;
                wpn.Remove();
            }
            var knife = p.GiveNamedItem<CBasePlayerWeapon>(w.Base);
            if (knife is not { IsValid: true }) return;
            knife.AcceptInput("ChangeSubclass", value: w.Vdata);
        }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] модель оружия {Key}: {Error}", s.WModel, ex.Message); }
    }
}
