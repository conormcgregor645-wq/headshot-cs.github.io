// TASHER: меню !vip (и админ-меню VIP) — один список в центре экрана, управление клавишами.
//   W / S — вверх / вниз, E или D — выбрать (вкл/выкл), A, R или Tab — закрыть. Пока меню открыто, игрок стоит на месте.
// Почему не три колонки, как было раньше: панель в центре экрана CS2 узкая — длинные строки переносились и ломали сетку,
// часть значков псевдографики шрифт игры не рисует, а админ-меню попадало в колонку «БОНУСЫ».
// Панель отправляется игроку только при изменении (и раз в несколько секунд, чтобы не погасла), а не каждый кадр.
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
        public int Index;
        public PlayerButtons Prev;
        public DateTime Sent = DateTime.MinValue, Touched = DateTime.UtcNow;
        public bool Dirty = true;
        public MoveType_t Move = MoveType_t.MOVETYPE_WALK;
    }

    private static readonly Dictionary<int, State> Opened = new();
    private static BasePlugin? _hookedBy;
    private const int Refresh = 4;      // секунд: панель живёт Refresh + 2 с, обновляем заранее
    private const int IdleClose = 30;   // секунд без нажатий — закрыть
    private const int Visible = 6;      // столько пунктов видно сразу, остальные — прокруткой

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

    public void Open(CCSPlayerController player)
    {
        if (player is not { IsValid: true } || player.IsBot) return;
        if (!ReferenceEquals(_hookedBy, plugin)) { plugin.RegisterListener<Listeners.OnTick>(Tick); _hookedBy = plugin; Opened.Clear(); }

        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true } || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
        {
            // клавиши мёртвого игрока управляют камерой наблюдения, а не меню — раньше меню открывалось и молча закрывалось
            player.PrintToChat($" {ChatColors.Gold}[VIP]{ChatColors.Default} Меню открывается, пока ты жив. Настройки действуют со следующего возрождения.");
            return;
        }

        if (Opened.TryGetValue(player.Slot, out var old))
        {
            // меню открылось заново (после выбора пункта или перехода в подменю): если это то же меню — курсор остаётся на месте
            var same = old.Menu.Title == Title && old.Menu.MenuOptions.Count == MenuOptions.Count;
            old.Menu = this;
            old.Index = same ? Math.Clamp(old.Index, 0, Math.Max(0, MenuOptions.Count - 1)) : FirstEnabled(MenuOptions);
            old.Dirty = true; old.Touched = DateTime.UtcNow;
            return;
        }

        var st = new State { Menu = this, Prev = player.Buttons, Index = FirstEnabled(MenuOptions) };
        st.Move = pawn.MoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : pawn.MoveType;
        SetMove(pawn, MoveType_t.MOVETYPE_NONE);
        Opened[player.Slot] = st;
    }

    public void OpenToAll()
    {
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false }) Open(p);
    }

    private static int FirstEnabled(List<ChatMenuOption> opts)
    {
        var i = opts.FindIndex(o => !o.Disabled);
        return i < 0 ? 0 : i;
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
                if ((pressed & (PlayerButtons.Scoreboard | PlayerButtons.Reload | PlayerButtons.Moveleft)) != 0) { Close(p, slot, st); continue; }

                var opts = st.Menu.MenuOptions;
                if (opts.Count > 0)
                {
                    if ((pressed & PlayerButtons.Forward) != 0) { Step(st, -1); st.Dirty = true; }
                    if ((pressed & PlayerButtons.Back) != 0) { Step(st, 1); st.Dirty = true; }
                    if ((pressed & (PlayerButtons.Use | PlayerButtons.Moveright)) != 0)
                    {
                        var o = opts[Math.Clamp(st.Index, 0, opts.Count - 1)];
                        if (!o.Disabled)
                        {
                            var who = p;
                            // действие пункта — на следующем кадре: оно может открыть это же или другое меню заново
                            Server.NextFrame(() => { if (who.IsValid) o.OnSelect(who, o); });
                        }
                        st.Dirty = true;
                    }
                }

                if (st.Dirty || (DateTime.UtcNow - st.Sent).TotalSeconds >= Refresh)
                {
                    p.PrintToCenterHtml(Render(st), Refresh + 2);
                    st.Sent = DateTime.UtcNow; st.Dirty = false;
                }
            }
            catch { Close(p, slot, st); }
        }
    }

    // вверх/вниз по кругу, недоступные пункты пропускаем
    private static void Step(State st, int dir)
    {
        var opts = st.Menu.MenuOptions;
        var n = opts.Count;
        if (n == 0) return;
        var i = Math.Clamp(st.Index, 0, n - 1);
        for (var k = 0; k < n; k++)
        {
            i = (i + dir + n) % n;
            if (!opts[i].Disabled) { st.Index = i; return; }
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

    private static string Line(ChatMenuOption o, bool selected)
    {
        var (name, state) = Split(o.Text);
        if (name.Length > 24) name = name[..23] + "…";
        var disabled = o.Disabled || state is "НЕТ ДОСТУПА" or "NO ACCESS";
        var nameColor = disabled ? Na : selected ? Gold : Txt;
        var mark = selected ? $"<font color='{Gold}'>► </font>" : "&nbsp;&nbsp;&nbsp;";
        var sb = new StringBuilder(mark);
        sb.Append($"<font color='{nameColor}'>{(selected ? "<b>" : "")}{Esc(name)}{(selected ? "</b>" : "")}</font>");
        if (state.Length > 0)
        {
            var c = disabled ? Na : state is "ВКЛ" or "ON" ? On : Off;
            sb.Append($"<font color='{c}'>&nbsp;&nbsp;{Esc(state)}</font>");
        }
        return sb.ToString();
    }

    private static string Render(State st)
    {
        var opts = st.Menu.MenuOptions;
        var sb = new StringBuilder(900);
        sb.Append($"<font class='fontSize-m' color='{Gold}'>TASHER · {Esc(Clean(st.Menu.Title))}</font><br>");
        if (opts.Count == 0)
        {
            sb.Append($"<font color='{Dim}'>Здесь пока ничего нет</font><br>");
            sb.Append($"<font class='fontSize-s' color='{Dim}'>R — закрыть</font>");
            return sb.ToString();
        }

        var sel = Math.Clamp(st.Index, 0, opts.Count - 1);
        // окно прокрутки: выбранный пункт всегда виден
        var start = Math.Clamp(sel - Visible / 2, 0, Math.Max(0, opts.Count - Visible));
        var end = Math.Min(opts.Count, start + Visible);
        sb.Append(start > 0 ? $"<font class='fontSize-s' color='{Dim}'>▲ ещё {start}</font><br>" : "");
        for (var i = start; i < end; i++) sb.Append(Line(opts[i], i == sel)).Append("<br>");
        sb.Append(end < opts.Count ? $"<font class='fontSize-s' color='{Dim}'>▼ ещё {opts.Count - end}</font><br>" : "");

        var toggles = opts.Any(o => Split(o.Text).State.Length > 0);
        sb.Append($"<font class='fontSize-s' color='{Dim}'>W/S — выбор · E — {(toggles ? "вкл/выкл" : "открыть")} · R — закрыть</font>");
        return sb.ToString();
    }
}
