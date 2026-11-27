// Свои модели игроков. Модели лежат в аддоне Мастерской (его скачивают игроки через MultiAddonManager, как озвучку),
// список моделей — в конфиге (Models: ключ → путь .vmdl для CT и T). Игрок покупает и надевает модель на сайте,
// сайт пишет её ключ в tasher_style.model. При возрождении ставим модель на персонажа; в !menu её можно выключить —
// тогда остаётся стандартный агент (или агент из инвентаря). Перчатки с кастомной моделью не надеваются.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace TasherStyle;

public partial class TasherStyle
{
    private void LoadModels()
    {
        // модели нужно загрузить заранее (precache), иначе SetModel покажет «ошибку» вместо персонажа
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            foreach (var m in Config.Models.Values)
                foreach (var path in new[] { m.Ct, m.T })
                    if (IsSafeModel(path)) manifest.AddResource(path);
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            var p = e.Userid;
            if (p is { IsValid: true, IsBot: false })
            {
                _modelOn.Remove(p.SteamID);
                AddTimer(0.5f, () => ApplyModel(p), TimerFlags.STOP_ON_MAPCHANGE);
            }
            return HookResult.Continue;
        });
        // Жёсткое правило: пока на игроке кастомная модель, перчатки не держатся (даже если надел их командой).
        AddTimer(1f, () =>
        {
            if (_modelOn.Count == 0) return;
            foreach (var p in Utilities.GetPlayers())
                if (p is { IsValid: true, IsBot: false, PawnIsAlive: true } && _modelOn.Contains(p.SteamID) && p.PlayerPawn.Value is { IsValid: true } pw)
                    StripGloves(pw);
        }, TimerFlags.REPEAT);
    }

    private readonly HashSet<ulong> _modelOn = new();

    private static bool IsSafeModel(string path) =>
        path.Length is > 6 and < 160 && path.EndsWith(".vmdl", StringComparison.Ordinal) && !path.Contains("..") && !path.Contains(';');

    private void ApplyModel(CCSPlayerController p)
    {
        if (!p.IsValid || !p.PawnIsAlive || p.PlayerPawn.Value is not { IsValid: true } pawn) return;
        var s = StyleOf(p);
        if (s is not { Model.Length: > 0 } || !PrefOn(p.SteamID, OffModel)) return;
        if (!Config.Models.TryGetValue(s.Model, out var m)) return;
        var path = p.TeamNum == 2 ? (m.T.Length > 0 ? m.T : m.Ct) : (m.Ct.Length > 0 ? m.Ct : m.T);
        if (!IsSafeModel(path)) return;
        try { pawn.SetModel(path); }
        catch (Exception ex) { Logger.LogWarning("[TASHER Style] модель {Key}: {Error}", s.Model, ex.Message); return; }
        _modelOn.Add(p.SteamID);
        // Перчатки (WeaponPaints или инвентарь) сделаны под руки стандартных агентов: на чужой модели они
        // ложатся криво — чёрные пятна и дыры. С кастомной моделью перчатки снимаем, остаются руки самой модели.
        // WeaponPaints надевает перчатки сразу после возрождения, поэтому повторяем ещё пару раз.
        StripGloves(pawn);
        foreach (var d in new[] { 0.3f, 1.5f })
            AddTimer(d, () => { if (p.IsValid && p.PawnIsAlive && p.PlayerPawn.Value is { IsValid: true } pw && pw == pawn) StripGloves(pw); }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static void StripGloves(CCSPlayerPawn pawn)
    {
        var g = pawn.EconGloves;
        if (g.ItemDefinitionIndex == 0 && !g.Initialized) return;
        g.NetworkedDynamicAttributes.Attributes.RemoveAll();
        g.AttributeList.Attributes.RemoveAll();
        g.ItemDefinitionIndex = 0;
        g.ItemID = 0;
        g.ItemIDLow = 0;
        g.ItemIDHigh = 0;
        g.Initialized = false;
        unchecked { pawn.EconGlovesChanged++; }
        Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_nEconGlovesChanged");
    }
}
