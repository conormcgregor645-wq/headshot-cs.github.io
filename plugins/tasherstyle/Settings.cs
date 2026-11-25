// !menu — личные настройки эффектов в игре: трассеры, след гранат, эффект и звук убийства, звук MVP.
// Белые трассеры и след гранат есть у всех. Эффекты, звуки и цветные варианты покупаются на сайте.
// Кто не купил, у того пункт выключен; попытка включить — сообщение в чат со ссылкой на сайт.
// Выбор хранится в таблице tasher_prefs (биты «выключено»), поэтому сохраняется между картами и заходами.
using System.Collections.Concurrent;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Menu;
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
        new(OffMvp, "Звук MVP", "звуки MVP", s => s is { MvpSnd.Length: > 0 }),
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

    private void OpenSettings(CCSPlayerController player)
    {
        var style = StyleOf(player);
        var menu = new CenterHtmlMenu("<font color='#b5e853'>TASHER</font> · настройки", this);
        foreach (var it in SettingsItems)
        {
            var owned = it.Owned(style);
            var on = owned && PrefOn(player.SteamID, it.Bit);
            var state = on ? "<font color='#7dff8a'>ВКЛ</font>" : owned ? "<font color='#ff6b6b'>ВЫКЛ</font>" : "<font color='#8a8a8a'>ВЫКЛ · нет</font>";
            var item = it;
            menu.AddMenuOption($"{it.Name}: {state}", (p, _) => Toggle(p, item));
        }
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
    }

    private void Toggle(CCSPlayerController p, MenuItem it)
    {
        if (!p.IsValid) return;
        if (!it.Owned(StyleOf(p)))
        {
            p.PrintToChat($"{Prefix}У тебя нет {it.Shop} — купить можно на {ChatColors.Lime}{Config.Site}{ChatColors.Default} в разделе «Оформление».");
            OpenSettings(p);
            return;
        }
        var off = _prefs.GetValueOrDefault(p.SteamID) ^ it.Bit;
        SavePref(p.SteamID, off);
        var on = (off & it.Bit) == 0;
        p.PrintToChat($"{Prefix}{it.Name}: {(on ? $"{ChatColors.Lime}включено" : $"{ChatColors.Red}выключено")}");
        OpenSettings(p);
    }
}
