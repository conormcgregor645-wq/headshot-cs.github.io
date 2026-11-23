// TASHER: меню !vip (и админ-меню VIP) — список в центре экрана; вкладки и 2 колонки — только если заданы вкладки.
//   A / D — вкладки, W / S — выбор пункта, E — выбрать (вкл/выкл), R или Tab — закрыть. Пока меню открыто, игрок стоит на месте.
// Вкладки можно задать через Tab("…") перед пунктами; сейчас !vip показывает только бонусы — одним списком, без вкладок.
// Панель в центре экрана держится, только пока её присылают постоянно: её перебивают подсказки игры и другие сообщения,
// поэтому она отправляется игроку каждый тик (как в стандартном меню CounterStrikeSharp), иначе меню мигает.
using System.Text;
using System.Text.RegularExpressions;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Menu;
using CounterStrikeSharp.API.Modules.Utils;

namespace VIPCore.Menus;

public class TasherMenu(string title, BasePlugin plugin) : IMenu
{
    private sealed class State
    {
        public required TasherMenu Menu;
        public int Tab, Index;           // Index — номер пункта внутри вкладки
        public PlayerButtons Prev;
        public DateTime Touched = DateTime.UtcNow;
        public string Html = "";
        public bool Dirty = true;
        public MoveType_t Move = MoveType_t.MOVETYPE_WALK;
    }

    private static readonly Dictionary<int, State> Opened = new();
    private static BasePlugin? _hookedBy;
    private const int IdleClose = 30;   // секунд без нажатий — закрыть
    private const int Cols = 2, Rows = 4; // карточек в строке и строк на экране

    private readonly List<string> _tabs = new();
    private readonly List<int> _optionTab = new();

    public string Title { get; set; } = title;
    public List<ChatMenuOption> MenuOptions { get; } = new();
    public PostSelectAction PostSelectAction { get; set; } = PostSelectAction.Close;
    public bool ExitButton { get; set; } = true;

    /// <summary>Пункты, добавленные после этого вызова, попадают во вкладку с таким названием.</summary>
    public void Tab(string name) => _tabs.Add(name);

    public ChatMenuOption AddMenuOption(string display, Action<CCSPlayerController, ChatMenuOption> onSelect, bool disabled = false)
    {
        var option = new ChatMenuOption(display, disabled, onSelect);
        MenuOptions.Add(option);
        _optionTab.Add(Math.Max(0, _tabs.Count - 1));
        return option;
    }

    private int TabCount => Math.Max(1, _tabs.Count);

    private List<int> ItemsOf(int tab)
    {
        var list = new List<int>();
        for (var i = 0; i < MenuOptions.Count; i++) if (_optionTab[i] == tab) list.Add(i);
        return list;
    }

    private string Signature => $"{Title}|{string.Join(",", _tabs)}|{MenuOptions.Count}";

    public void Open(CCSPlayerController player)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!ReferenceEquals(_hookedBy, plugin)) { plugin.RegisterListener<Listeners.OnTick>(Tick); _hookedBy = plugin; Opened.Clear(); }

        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true } || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
        {
            // клавиши мёртвого игрока управляют камерой наблюдения, а не меню
            player.PrintToChat($" {ChatColors.Gold}[VIP]{ChatColors.Default} Меню открывается, пока ты жив. Настройки действуют со следующего возрождения.");
            return;
        }

        if (Opened.TryGetValue(player.Slot, out var old))
        {
            // меню открылось заново (после выбора пункта или перехода в подменю): то же меню — вкладка и курсор остаются
            var same = old.Menu.Signature == Signature;
            old.Menu = this;
            if (!same) { old.Tab = FirstTab(); old.Index = FirstEnabled(old.Tab); }
            Fix(old);
            old.Dirty = true; old.Touched = DateTime.UtcNow;
            return;
        }

        var st = new State { Menu = this, Prev = player.Buttons, Tab = FirstTab() };
        st.Index = FirstEnabled(st.Tab);
        st.Move = pawn.MoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : pawn.MoveType;
        SetMove(pawn, MoveType_t.MOVETYPE_NONE);
        Opened[player.Slot] = st;
    }

    public void OpenToAll()
    {
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false }) Open(p);
    }

    private int FirstTab()
    {
        for (var t = 0; t < TabCount; t++) if (ItemsOf(t).Count > 0) return t;
        return 0;
    }

    private int FirstEnabled(int tab)
    {
        var items = ItemsOf(tab);
        var i = items.FindIndex(o => !MenuOptions[o].Disabled);
        return i < 0 ? 0 : i;
    }

    private static void Fix(State st)
    {
        st.Tab = Math.Clamp(st.Tab, 0, st.Menu.TabCount - 1);
        st.Index = Math.Clamp(st.Index, 0, Math.Max(0, st.Menu.ItemsOf(st.Tab).Count - 1));
    }

    private static void SetMove(CCSPlayerPawn pawn, MoveType_t t)
    {
        pawn.MoveType = t; pawn.ActualMoveType = t;
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
    }

    private static void Close(CCSPlayerController? p, int slot, State st)
    {
        Opened.Remove(slot);
        if (p is not { IsValid: true }) return;
        var pawn = p.PlayerPawn.Value;
        if (pawn is { IsValid: true } && pawn.MoveType == MoveType_t.MOVETYPE_NONE) SetMove(pawn, st.Move);
        p.PrintToCenterHtml(" ", 1);
    }

    private static void Tick()
    {
        if (Opened.Count == 0) return;
        foreach (var slot in Opened.Keys.ToArray())
        {
            if (!Opened.TryGetValue(slot, out var st)) continue;
            CCSPlayerController? p = null;
            try
            {
                p = Utilities.GetPlayerFromSlot(slot);
                var pawn = p?.PlayerPawn.Value;
                if (p is not { IsValid: true } || pawn is not { IsValid: true } || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE
                    || (DateTime.UtcNow - st.Touched).TotalSeconds > IdleClose)
                { Close(p, slot, st); continue; }

                // новый раунд возвращает игроку обычное движение — снова держим его на месте, пока меню открыто
                if (pawn.MoveType == MoveType_t.MOVETYPE_WALK) SetMove(pawn, MoveType_t.MOVETYPE_NONE);

                var b = p.Buttons; var pressed = b & ~st.Prev; st.Prev = b;
                if (pressed != 0) st.Touched = DateTime.UtcNow;
                if ((pressed & (PlayerButtons.Scoreboard | PlayerButtons.Reload)) != 0) { Close(p, slot, st); continue; }

                var m = st.Menu;
                if ((pressed & PlayerButtons.Moveleft) != 0) { SwitchTab(st, -1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Moveright) != 0) { SwitchTab(st, 1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Forward) != 0) { Step(st, -1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Back) != 0) { Step(st, 1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Use) != 0)
                {
                    var items = m.ItemsOf(st.Tab);
                    if (items.Count > 0)
                    {
                        var o = m.MenuOptions[items[Math.Clamp(st.Index, 0, items.Count - 1)]];
                        if (!o.Disabled)
                        {
                            var who = p;
                            // действие пункта — на следующем кадре: оно может открыть это же или другое меню заново
                            Server.NextFrame(() => { if (who.IsValid) o.OnSelect(who, o); });
                        }
                    }
                    st.Dirty = true;
                }

                if (st.Dirty) { st.Html = Render(st); st.Dirty = false; }
                p.PrintToCenterHtml(st.Html, 1);
            }
            catch { Close(p, slot, st); }
        }
    }

    // вкладки по кругу, пустые пропускаем
    private static void SwitchTab(State st, int dir)
    {
        var m = st.Menu; var n = m.TabCount;
        if (n <= 1) return;
        var t = st.Tab;
        for (var k = 0; k < n; k++)
        {
            t = (t + dir + n) % n;
            if (m.ItemsOf(t).Count > 0) { st.Tab = t; st.Index = m.FirstEnabled(t); return; }
        }
    }

    // вверх/вниз по пунктам вкладки (слева направо, сверху вниз), по кругу; недоступные пропускаем
    private static void Step(State st, int dir)
    {
        var m = st.Menu; var items = m.ItemsOf(st.Tab); var n = items.Count;
        if (n == 0) return;
        var i = Math.Clamp(st.Index, 0, n - 1);
        for (var k = 0; k < n; k++)
        {
            i = (i + dir + n) % n;
            if (!m.MenuOptions[items[i]].Disabled) { st.Index = i; return; }
        }
    }

    // ---------- вид ----------
    private static readonly Regex Tags = new("<[^>]+>", RegexOptions.Compiled);
    private const string Gold = "#ffcf40", Dim = "#8b93a1", Txt = "#e8ebf0", On = "#3ddc97", Off = "#ff6b6b", Na = "#5b6270";

    // цвета чата CS2 (управляющие символы) и квадратные скобки в HTML-панели не нужны
    private static string Clean(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var ch in Tags.Replace(s, "")) if (!char.IsControl(ch) && ch != '[' && ch != ']') sb.Append(ch);
        return sb.ToString().Trim();
    }
    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    // «Здоровье [ВКЛ]» -> («Здоровье», «ВКЛ»)
    private static (string Name, string State) Split(string text)
    {
        var plain = Clean(text);
        foreach (var v in new[] { "НЕТ ДОСТУПА", "ВЫКЛ", "ВКЛ", "NO ACCESS", "OFF", "ON" })
            if (plain.EndsWith(" " + v, StringComparison.OrdinalIgnoreCase))
                return (plain[..^(v.Length + 1)].Trim(), v.ToUpperInvariant());
        return (plain, "");
    }

    private static string Card(ChatMenuOption o, bool selected, int maxName)
    {
        var (name, state) = Split(o.Text);
        if (name.Length > maxName) name = name[..(maxName - 1)] + "…";
        var disabled = o.Disabled || state is "НЕТ ДОСТУПА" or "NO ACCESS";
        var sb = new StringBuilder();
        sb.Append(selected ? $"<font color='{Gold}'>&gt; </font>" : "&nbsp;&nbsp;&nbsp;");
        var nc = disabled ? Na : selected ? Gold : Txt;
        sb.Append($"<font color='{nc}'>{(selected ? "<b>" : "")}{Esc(name)}{(selected ? "</b>" : "")}</font>");
        if (state.Length > 0)
        {
            var c = disabled ? Na : state is "ВКЛ" or "ON" ? On : Off;
            var label = state is "НЕТ ДОСТУПА" or "NO ACCESS" ? "—" : state;
            sb.Append($"<font color='{c}'>&nbsp;{Esc(label)}</font>");
        }
        return sb.ToString();
    }

    private static string Render(State st)
    {
        var m = st.Menu;
        var sb = new StringBuilder(1200);
        sb.Append($"<font class='fontSize-m' color='{Gold}'>TASHER · {Esc(Clean(m.Title))}</font><br>");

        var tabs = m.TabCount > 1;
        if (tabs)
        {
            sb.Append($"<font class='fontSize-s' color='{Dim}'>A&nbsp;&nbsp;</font>");
            for (var t = 0; t < m.TabCount; t++)
            {
                if (t > 0) sb.Append($"<font color='{Dim}'>&nbsp;|&nbsp;</font>");
                var name = Esc(m._tabs[t].ToUpperInvariant());
                sb.Append(t == st.Tab ? $"<font color='{Gold}'><b>{name}</b></font>" : $"<font color='{Dim}'>{name}</font>");
            }
            sb.Append($"<font class='fontSize-s' color='{Dim}'>&nbsp;&nbsp;D</font><br>");
        }

        var items = m.ItemsOf(st.Tab);
        if (items.Count == 0)
        {
            sb.Append($"<font color='{Dim}'>Здесь пока ничего нет</font><br>");
        }
        else
        {
            // одна колонка, если пунктов мало или это меню без вкладок с длинными названиями (админ-меню, список игроков)
            var cols = tabs ? Cols : 1;
            var sel = Math.Clamp(st.Index, 0, items.Count - 1);
            var totalRows = (items.Count + cols - 1) / cols;
            var visRows = tabs ? Rows : Rows + 2;
            var selRow = sel / cols;
            var startRow = Math.Clamp(selRow - visRows / 2, 0, Math.Max(0, totalRows - visRows));
            var endRow = Math.Min(totalRows, startRow + visRows);
            var maxName = cols == 1 ? 26 : 12;

            if (startRow > 0) sb.Append($"<font class='fontSize-s' color='{Dim}'>▲</font><br>");
            for (var r = startRow; r < endRow; r++)
            {
                for (var c = 0; c < cols; c++)
                {
                    var i = r * cols + c;
                    if (i >= items.Count) break;
                    if (c > 0) sb.Append($"<font color='{Dim}'>&nbsp;&nbsp;&nbsp;</font>");
                    sb.Append(Card(m.MenuOptions[items[i]], i == sel, maxName));
                }
                sb.Append("<br>");
            }
            if (endRow < totalRows) sb.Append($"<font class='fontSize-s' color='{Dim}'>▼</font><br>");
        }

        var toggles = items.Any(i => Split(m.MenuOptions[i].Text).State.Length > 0);
        // короткая подсказка — длинная переносилась на вторую строку
        sb.Append($"<font class='fontSize-s' color='{Dim}'>W/S{(tabs ? " · A/D" : "")} · E {(toggles ? "вкл/выкл" : "выбрать")} · R закрыть</font>");
        return sb.ToString();
    }
}
