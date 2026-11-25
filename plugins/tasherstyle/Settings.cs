// !menu — личные настройки эффектов в игре (управление W/S/E): трассеры, след гранат, эффект и звук убийства, звук MVP.
// Белые трассеры и след гранат есть у всех. Эффекты, звуки и цветные варианты покупаются на сайте.
// Кто не купил, у того пункт выключен; попытка включить — сообщение в чат со ссылкой на сайт.
// Выбор хранится в таблице tasher_prefs (биты «выключено»), поэтому сохраняется между картами и заходами.
using System.Collections.Concurrent;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using MySqlConnector;

namespace TasherStyle;

public partial class TasherStyle
{
    // биты в tasher_prefs.off: 1 — трассеры, 2 — след гранат, 4 — эффект убийства, 8 — звук убийства, 16 — звук MVP
    private const int OffTracer = 1, OffTrail = 2, OffKillFx = 4, OffKillSnd = 8, OffMvp = 16;
    private readonly ConcurrentDictionary<ulong, int> _prefs = new();
    // белый по умолчанию — у всех, без покупки
    private const string DefaultWhite = "255 255 255";

    private record MenuItem(int Bit, string Name, string Shop, Func<PlayerStyle?, bool> Owned);

    private static readonly MenuItem[] SettingsItems =
    {
        new(OffTracer, "Трассеры пуль", "", _ => true),
        new(OffTrail, "След гранат", "", _ => true),
        new(OffKillFx, "Эффект убийства", "эффекты убийства", s => s is { KillFx.Length: > 0 }),
        new(OffKillSnd, "Звук убийства", "звуки убийства", s => s is { KillSnd.Length: > 0 }),
    };

    private bool PrefOn(ulong sid, int bit) => !(_prefs.TryGetValue(sid, out var f) && (f & bit) != 0);

    private static async Task CreatePrefsTableAsync(MySqlConnection c)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "CREATE TABLE IF NOT EXISTS tasher_prefs (steamid BIGINT UNSIGNED NOT NULL PRIMARY KEY, off INT NOT NULL DEFAULT 0) DEFAULT CHARSET=utf8mb4";
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task LoadPrefsAsync(MySqlConnection c)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT steamid, off FROM tasher_prefs";
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) _prefs[r.GetUInt64(0)] = r.GetInt32(1);
    }

    private void SavePref(ulong sid, int off)
    {
        _prefs[sid] = off;
        Task.Run(async () =>
        {
            try
            {
                await using var c = new MySqlConnection(ConnString);
                await c.OpenAsync();
                await CreatePrefsTableAsync(c);
                await using var cmd = c.CreateCommand();
                cmd.CommandText = "INSERT INTO tasher_prefs (steamid, off) VALUES (@s, @o) ON DUPLICATE KEY UPDATE off=@o";
                cmd.Parameters.AddWithValue("@s", sid);
                cmd.Parameters.AddWithValue("@o", off);
                await cmd.ExecuteNonQueryAsync();
            }
            catch (Exception e) { Logger.LogError("[TASHER Style] не удалось сохранить настройки: {Error}", e.Message); }
        });
    }

    [ConsoleCommand("css_menu", "Настройки эффектов: трассеры, след гранат, эффекты и звуки")]
    [ConsoleCommand("css_settings", "Настройки эффектов")]
    public void OnMenuCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true, IsBot: false }) return;
        OpenSettings(player);
    }

    // Меню на W/S/E: W — вверх, S — вниз, E — переключить, R или !menu ещё раз — закрыть.
    // Пока меню открыто, живой игрок стоит на месте (иначе W/S двигали бы его); через 20 с без нажатий меню закрывается.
    private sealed class MenuState { public int Idx; public ulong Prev; public float Last; public bool Frozen; }
    private readonly Dictionary<int, MenuState> _menus = new();
    private bool _menuTickOn;

    private void OpenSettings(CCSPlayerController player)
    {
        if (_menus.ContainsKey(player.Slot)) { CloseSettings(player); return; }
        var st = new MenuState { Prev = (ulong)player.Buttons, Last = Server.CurrentTime };
        if (player.PawnIsAlive && player.PlayerPawn.Value is { } pawn)
        {
            pawn.MoveType = MoveType_t.MOVETYPE_NONE;
            Schema.SetSchemaValue(pawn.Handle, "CBaseEntity", "m_nActualMoveType", 0);
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
            st.Frozen = true;
        }
        _menus[player.Slot] = st;
        if (!_menuTickOn) { _menuTickOn = true; RegisterListener<Listeners.OnTick>(MenuTick); }
    }

    private void CloseSettings(CCSPlayerController player)
    {
        if (!_menus.Remove(player.Slot, out var st)) return;
        if (st.Frozen && player.IsValid && player.PawnIsAlive && player.PlayerPawn.Value is { } pawn)
        {
            pawn.MoveType = MoveType_t.MOVETYPE_WALK;
            Schema.SetSchemaValue(pawn.Handle, "CBaseEntity", "m_nActualMoveType", 2);
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
        }
        if (player.IsValid) player.PrintToCenterHtml(" ", 1);
    }

    private void MenuTick()
    {
        if (_menus.Count == 0) return;
        foreach (var slot in _menus.Keys.ToList())
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            if (p is not { IsValid: true } || p.IsBot) { _menus.Remove(slot); continue; }
            var st = _menus[slot];
            var b = (ulong)p.Buttons; var pressed = b & ~st.Prev; st.Prev = b;
            var now = Server.CurrentTime;
            if (pressed != 0) st.Last = now;
            if ((pressed & (ulong)PlayerButtons.Forward) != 0) st.Idx = (st.Idx + SettingsItems.Length - 1) % SettingsItems.Length;
            if ((pressed & (ulong)PlayerButtons.Back) != 0) st.Idx = (st.Idx + 1) % SettingsItems.Length;
            if ((pressed & (ulong)PlayerButtons.Use) != 0) Toggle(p, SettingsItems[st.Idx]);
            if ((pressed & (ulong)PlayerButtons.Reload) != 0 || now - st.Last > 20f) { CloseSettings(p); continue; }
            // центр экрана перерисовываем каждый тик — иначе надпись мигает
            p.PrintToCenterHtml(MenuHtml(p, st.Idx), 1);
        }
    }

    private string MenuHtml(CCSPlayerController p, int idx)
    {
        var style = StyleOf(p);
        var sb = new System.Text.StringBuilder("<font class='fontSize-m' color='#b5e853'>TASHER</font><font class='fontSize-m' color='#ffffff'> · настройки</font><br>");
        for (var i = 0; i < SettingsItems.Length; i++)
        {
            var it = SettingsItems[i];
            var owned = it.Owned(style);
            var on = owned && PrefOn(p.SteamID, it.Bit);
            var state = on ? "<font color='#7dff8a'>ВКЛ</font>" : owned ? "<font color='#ff6b6b'>ВЫКЛ</font>" : "<font color='#8a8a8a'>нет</font>";
            sb.Append(i == idx
                ? $"<font color='#f5c451'>▶ {it.Name}</font> {state}<br>"
                : $"<font color='#cfcfcf'>{it.Name}</font> {state}<br>");
        }
        sb.Append("<font class='fontSize-s' color='#8a8a8a'>W/S — выбор · E — вкл/выкл · R — закрыть</font>");
        return sb.ToString();
    }

    private void Toggle(CCSPlayerController p, MenuItem it)
    {
        if (!p.IsValid) return;
        if (!it.Owned(StyleOf(p)))
        {
            p.PrintToChat($"{Prefix}У тебя нет {it.Shop} — купить можно на {ChatColors.Lime}{Config.Site}{ChatColors.Default} в разделе «Оформление».");
            return;
        }
        var off = _prefs.GetValueOrDefault(p.SteamID) ^ it.Bit;
        SavePref(p.SteamID, off);
        var on = (off & it.Bit) == 0;
        p.PrintToChat($"{Prefix}{it.Name}: {(on ? $"{ChatColors.Lime}включено" : $"{ChatColors.Red}выключено")}");
    }
}
