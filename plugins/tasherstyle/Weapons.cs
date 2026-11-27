// Свои модели оружия (ножи, пистолеты, автоматы). Как это работает в CS2 после обновления анимаций (AnimGraph2):
//  • в аддоне Мастерской лежат модели и СВОЙ scripts/weapons.vdata — копия игрового файла с добавленными записями
//    (например weapon_tasher_rose), где указаны наши модели. Игроки скачивают аддон — игра знает эти записи,
//    поэтому модель видно и от первого лица, и со стороны;
//  • плагин переключает оружие игрока на нашу запись: AcceptInput("ChangeSubclass", Vdata).
//    Нож — через 1,5 с после возрождения (позже, чем WeaponPaints выдаёт нож из инвентаря): старый нож убираем, выдаём новый.
//    Пистолет/автомат — когда у игрока появляется оружие класса Base (купил, поднял, выдали на старте).
//    Если оружие со своей моделью поднял игрок без неё — возвращаем обычную запись (Base).
//  • запись в vdata — копия записи того оружия, под чей скелет сделана модель (кукри — "526", Desert Eagle — "1"…),
//    иначе анимации не совпадут и игра может упасть. Это делает tools/weapons/Build-Weapons.ps1, он же печатает
//    готовые команды weapon-model-add.sh с правильными Base и Def.
// Настройки — WeaponModels в конфиге (скрипт weapon-model-add.sh). Игрок надевает модели на сайте (до трёх: нож,
// пистолет, основное), выключает в !menu («Своё оружие»).
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    private readonly Dictionary<uint, WeaponModelCfg> _customWeapons = new(); // индекс оружия → наша модель

    private void LoadWeaponModels()
    {
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            foreach (var w in Config.WeaponModels.Values)
                if (IsSafeModel(w.Model)) manifest.AddResource(w.Model);
        });
        RegisterListener<Listeners.OnMapStart>(_ => _customWeapons.Clear());
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true, IsBot: false } && Config.WeaponModels.Count > 0)
                AddTimer(1.5f, () => ApplyWeaponModels(p, true), TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventItemPickup>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true } && Config.WeaponModels.Count > 0)
                Server.NextFrame(() => ApplyWeaponModels(p, false));
            return HookResult.Continue;
        });
    }

    private static bool IsSafeName(string s) => s.Length is > 3 and < 64 && s.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '_');
    private static bool IsKnife(string designer) => designer.Contains("knife") || designer.Contains("bayonet");

    private List<WeaponModelCfg> MyWeaponModels(CCSPlayerController p)
    {
        var list = new List<WeaponModelCfg>();
        if (p.IsBot || !PrefOn(p.SteamID, OffWModel)) return list;
        var s = StyleOf(p);
        if (s is not { WModel.Length: > 0 }) return list;
        foreach (var k in s.WModel.Split(',', StringSplitOptions.RemoveEmptyEntries))
            if (Config.WeaponModels.TryGetValue(k, out var w) && IsSafeName(w.Base) && IsSafeName(w.Vdata)) list.Add(w);
        return list;
    }

    private void ApplyWeaponModels(CCSPlayerController p, bool spawn)
    {
        if (!p.IsValid || !p.PawnIsAlive || p.PlayerPawn.Value is not { IsValid: true } pawn || pawn.WeaponServices is not { } ws) return;
        try
        {
            var mine = MyWeaponModels(p);
            var weapons = ws.MyWeapons.Select(h => h.Value).Where(w => w is { IsValid: true }).Cast<CBasePlayerWeapon>().ToList();

            // нож: при возрождении меняем на свой
            var knifeCfg = mine.FirstOrDefault(w => w.Slot == 2);
            if (spawn && knifeCfg != null)
            {
                foreach (var w in weapons.Where(w => IsKnife(w.DesignerName) || (_customWeapons.TryGetValue(w.Index, out var c) && c.Slot == 2)))
                { _customWeapons.Remove(w.Index); w.Remove(); }
                var knife = p.GiveNamedItem<CBasePlayerWeapon>("weapon_knife");
                if (knife is { IsValid: true }) SetSubclass(knife, knifeCfg);
                weapons = weapons.Where(w => w.IsValid).ToList();
            }

            // пистолеты и основное оружие
            foreach (var w in weapons)
            {
                if (!w.IsValid) continue;
                var isCustom = _customWeapons.TryGetValue(w.Index, out var cur);
                if (isCustom && cur!.Slot == 2) continue;
                if (!isCustom && IsKnife(w.DesignerName)) continue;
                var baseName = isCustom ? cur!.Base : w.DesignerName;
                var cfg = mine.FirstOrDefault(c => c.Slot != 2 && c.Base == baseName);
                if (cfg != null && (!isCustom || cur!.Vdata != cfg.Vdata)) SetSubclass(w, cfg);
                else if (cfg == null && isCustom)
                {
                    // оружие со своей моделью подобрал игрок без неё — возвращаем обычное
                    _customWeapons.Remove(w.Index);
                    w.AcceptInput("ChangeSubclass", value: cur!.Base);
                }
            }
        }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] модели оружия: {Error}", ex.Message); }
    }

    // WeaponPaints сразу после выдачи оружия ставит свой нож (ChangeSubclass) и раскраску — на следующем кадре.
    // Поэтому свою запись ставим сразу и повторяем через 0,2 и 0,8 с, пока оружие у того же владельца.
    private void SetSubclass(CBasePlayerWeapon w, WeaponModelCfg cfg)
    {
        _customWeapons[w.Index] = cfg;
        Apply(true);
        var idx = w.Index;
        foreach (var d in new[] { 0.2f, 0.8f })
            AddTimer(d, () =>
            {
                if (!w.IsValid || !_customWeapons.TryGetValue(idx, out var c) || c != cfg) return;
                Apply(false);
            }, TimerFlags.STOP_ON_MAPCHANGE);

        void Apply(bool first)
        {
            try
            {
                var it = w.AttributeManager.Item;
                // повторно — только если запись сбили (WeaponPaints меняет номер ножа); у пистолетов и автоматов
                // повторная смена сбросила бы патроны
                if (first || (cfg.Def > 0 && it.ItemDefinitionIndex != cfg.Def))
                    w.AcceptInput("ChangeSubclass", value: cfg.Vdata);
                if (cfg.Def > 0) it.ItemDefinitionIndex = (ushort)cfg.Def;
                // раскраска из инвентаря рассчитана на обычную модель — на своей модели она не нужна
                it.NetworkedDynamicAttributes.Attributes.RemoveAll();
                it.AttributeList.Attributes.RemoveAll();
                w.FallbackPaintKit = 0; w.FallbackSeed = 0; w.FallbackWear = 0;
            }
            catch (Exception ex) { Logger.LogWarning("[TASHER Style] модель оружия {Vdata}: {Error}", cfg.Vdata, ex.Message); }
        }
    }
}
