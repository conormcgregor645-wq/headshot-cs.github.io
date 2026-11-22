using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Extensions;
using CounterStrikeSharp.API.Modules.Timers;

namespace VIPCore.Menus;

public sealed class BuyMenu
{
    public sealed record Item(string Key, string Name, string Status, bool Enabled, bool Active, bool Toggle, Action<CCSPlayerController, int> Select);
    private sealed class Session
    {
        public required List<Item>[] Columns;
        public required string Group;
        public readonly string?[] Icons = new string?[3 * Rows];
        public int Page;
        public int Pages => Math.Max(1, (Columns.Max(c => c.Count) + Rows - 1) / Rows);
        public DateTime LastInput = DateTime.UtcNow;
    }

    private const int Rows = 4;
    private const string Layout = "panorama/layout/custom_game/tasher_buy.vxml_c";
    private readonly Dictionary<int, Session> _sessions = new();
    private CCSCustomHudLayout? _hud;

    public BuyMenu(Plugin plugin)
    {
        plugin.RegisterListener<Listeners.OnCustomHudClicked>(Click);
        plugin.RegisterListener<Listeners.OnClientDisconnect>(slot =>
        {
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } player) Close(player);
            else _sessions.Remove(slot);
        });
        plugin.RegisterListener<Listeners.OnMapEnd>(Reset);
        plugin.RegisterEventHandler<EventPlayerDeath>((ev, _) =>
        {
            if (ev.Userid is { IsValid: true } player) Close(player);
            return HookResult.Continue;
        });
        plugin.AddCommand("css_vip_close", "Закрыть полноэкранное VIP-меню", (p, _) => { if (p != null) Close(p); });
        plugin.AddTimer(1f, () =>
        {
            foreach (var (slot, session) in _sessions.ToArray())
                if ((DateTime.UtcNow - session.LastInput).TotalSeconds >= 30 && Utilities.GetPlayerFromSlot(slot) is { IsValid: true } player)
                    Close(player);
        }, TimerFlags.REPEAT);
    }

    public bool Open(CCSPlayerController player, string group, List<Item> items, int page)
    {
        if (_hud is not { IsValid: true })
        {
            _hud = Utilities.CreateEntityByName<CCSCustomHudLayout>("custom_hud_layout");
            if (_hud is null) return false;
            _hud.StrLayout = Layout;
            _hud.DispatchSpawn();
        }
        Close(player);
        List<Item>[] columns = [[], [], []];
        foreach (var item in items)
        {
            var column = item.Key.ToLowerInvariant() switch
            {
                "armor" or "health" or "healthregen" or "vampirism" => 0,
                "grenades" or "zeus" or "defusekit" or "healthshot" or "items" => 1,
                _ => 2
            };
            columns[column].Add(item);
        }
        var session = new Session { Columns = columns, Group = group };
        session.Page = Math.Clamp(page, 0, session.Pages - 1);
        _sessions[player.Slot] = session;
        Draw(player, session);
        _hud.SetHasClassForPlayer(player, "shop", "Hidden", false);
        _hud.SetInputCaptureEnabled(player, true);
        return true;
    }

    private void Draw(CCSPlayerController player, Session s)
    {
        var hud = _hud!;
        hud.SetDialogVariableStringForPlayer(player, "shop", "group", s.Group);
        hud.SetDialogVariableStringForPlayer(player, "shop", "page", $"{s.Page + 1} / {s.Pages}");
        hud.SetHasClassForPlayer(player, "pager", "Hidden", s.Pages == 1);
        hud.SetHasClassForPlayer(player, "empty", "Hidden", s.Columns.Any(c => c.Count > 0));
        for (var col = 0; col < s.Columns.Length; col++)
        for (var row = 0; row < Rows; row++)
        {
            var id = $"vip_{col}_{row}";
            var pos = s.Page * Rows + row;
            var visible = pos < s.Columns[col].Count;
            hud.SetHasClassForPlayer(player, id, "Hidden", !visible);
            if (!visible) continue;
            var item = s.Columns[col][pos];
            hud.SetDialogVariableStringForPlayer(player, "shop", id + "_name", item.Name);
            hud.SetDialogVariableStringForPlayer(player, "shop", id + "_status", item.Status);
            var icon = Icon(item.Key);
            var slot = col * Rows + row;
            if (s.Icons[slot] != icon)
            {
                if (s.Icons[slot] is string previous) hud.SetHasClassForPlayer(player, id, previous, false);
                hud.SetHasClassForPlayer(player, id, icon, true);
                s.Icons[slot] = icon;
            }
            var action = !item.Enabled ? "Нет доступа" : item.Active ? "ЛКМ · Выключить" :
                item.Toggle ? "ЛКМ · Включить" : "ЛКМ · Открыть";
            hud.SetDialogVariableStringForPlayer(player, "shop", id + "_action", action);
            hud.SetHasClassForPlayer(player, id, "Locked", !item.Enabled);
            hud.SetHasClassForPlayer(player, id, "Active", item.Active);
        }
    }

    private static string Icon(string key) => key.ToLowerInvariant() switch
    {
        "armor" => "Armor", "health" => "Health", "healthregen" => "Regen",
        "vampirism" => "Vampire", "grenades" => "Grenades", "zeus" => "Zeus",
        "healthshot" => "Healthshot", "defusekit" => "Kit", "money" => "Money",
        "smokecolor" => "Smoke", _ => "Other"
    };

    private void Click(CCSPlayerController player, CCSCustomHudLayout layout, string id)
    {
        if (_hud is not { IsValid: true } || player is not { IsValid: true } ||
            layout.Handle != _hud.Handle || !_sessions.TryGetValue(player.Slot, out var s)) return;
        s.LastInput = DateTime.UtcNow;
        if (id == "close") { Close(player); return; }
        if (id is "prev" or "next")
        {
            s.Page = Math.Clamp(s.Page + (id == "next" ? 1 : -1), 0, s.Pages - 1);
            Draw(player, s);
            return;
        }
        for (var col = 0; col < s.Columns.Length; col++)
        for (var row = 0; row < Rows; row++)
        {
            if (id != $"vip_{col}_{row}") continue;
            var pos = s.Page * Rows + row;
            if (pos >= s.Columns[col].Count || !s.Columns[col][pos].Enabled) return;
            var item = s.Columns[col][pos];
            Close(player);
            item.Select(player, s.Page);
            return;
        }
    }

    private void Close(CCSPlayerController player)
    {
        if (!_sessions.Remove(player.Slot, out var session) || _hud is not { IsValid: true }) return;
        _hud.SetInputCaptureEnabled(player, false);
        _hud.SetHasClassForPlayer(player, "shop", "Hidden", true);
        for (var i = 0; i < session.Icons.Length; i++)
            if (session.Icons[i] is string icon)
                _hud.SetHasClassForPlayer(player, $"vip_{i / Rows}_{i % Rows}", icon, false);
    }

    public void Reset()
    {
        foreach (var slot in _sessions.Keys.ToArray())
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } player) Close(player);
        _sessions.Clear();
        if (_hud is { IsValid: true }) _hud.Remove();
        _hud = null;
    }
}
