// TASHER: меню VIP на клавишах W/S (вверх-вниз), E (выбрать), Tab (закрыть) вместо ввода !1…!9 в чат.
// Обёртка над меню CS2MenuManager (WasdMenu) с интерфейсом меню CounterStrikeSharp, которое использует VIPCore.
using System.Text;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Menu;

namespace VIPCore.Menus;

public class WasdMenuAdapter(string title, BasePlugin plugin) : IMenu
{
    // после выбора пункта меню открывается заново — курсор остаётся на том же пункте
    private static readonly Dictionary<ulong, (string Title, int Index, DateTime At)> LastChoice = new();

    public string Title { get; set; } = title;
    public List<ChatMenuOption> MenuOptions { get; } = new();
    public PostSelectAction PostSelectAction { get; set; } = PostSelectAction.Close;
    public bool ExitButton { get; set; } = true;

    public ChatMenuOption AddMenuOption(string display, Action<CCSPlayerController, ChatMenuOption> onSelect, bool disabled = false)
    {
        var option = new ChatMenuOption(display, disabled, onSelect);
        MenuOptions.Add(option);
        return option;
    }

    // цветовые коды чата ({blue} и т.п. уже превращены в управляющие символы) в HTML-меню не нужны
    private static string Clean(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var ch in text)
            if (ch >= ' ' && ch != '[' && ch != ']') sb.Append(ch);
        return sb.ToString().Trim();
    }

    public void Open(CCSPlayerController player)
    {
        if (player is not { IsValid: true } || player.IsBot) return;

        var title = Clean(Title);
        var menu = new CS2MenuManager.API.Menu.WasdMenu(title, plugin) { ExitButton = ExitButton };

        for (var i = 0; i < MenuOptions.Count; i++)
        {
            var option = MenuOptions[i];
            var index = i;
            if (option.Disabled)
            {
                menu.AddItem(option.Text, CS2MenuManager.API.Enum.DisableOption.DisableHideNumber);
                continue;
            }

            menu.AddItem(option.Text, (p, item) =>
            {
                item.PostSelectAction = CS2MenuManager.API.Enum.PostSelectAction.Close;
                LastChoice[p.SteamID] = (title, index, DateTime.UtcNow);
                // действие пункта — на следующем кадре, когда это меню уже закрыто
                Server.NextFrame(() =>
                {
                    if (p.IsValid) option.OnSelect(p, option);
                });
            });
        }

        if (LastChoice.TryGetValue(player.SteamID, out var last) && last.Title == title &&
            (DateTime.UtcNow - last.At).TotalSeconds < 3 && last.Index < MenuOptions.Count)
            menu.DisplayAt(player, last.Index, 0);
        else
            menu.Display(player, 0);
    }

    public void OpenToAll()
    {
        foreach (var player in Utilities.GetPlayers())
            if (player is { IsValid: true, IsBot: false })
                Open(player);
    }
}
