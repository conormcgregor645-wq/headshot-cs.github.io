// TASHER: своё меню !vip в стиле сайта — панель по центру экрана, как список закупки в CS2.
// W/S — выбор, E — включить или выключить, Tab или R — закрыть. Пока меню открыто, игрок стоит на месте.
// Панель отправляется игроку только при изменении (раз в несколько секунд — чтобы не погасла), а не каждый кадр,
// поэтому меню не нагружает сервер и сеть и откликается сразу.
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

    private static readonly Dictionary<int, State> Open_ = new();
    private static BasePlugin? _hookedBy;
    private const int Visible = 7;      // строк на экране, дальше — прокрутка
    private const int Refresh = 4;      // секунд: панель живёт 6 с, обновляем заранее
    private const int IdleClose = 30;   // секунд без нажатий — закрыть

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
        if (!ReferenceEquals(_hookedBy, plugin)) { plugin.RegisterListener<Listeners.OnTick>(Tick); _hookedBy = plugin; Open_.Clear(); }
        var pawn = player.PlayerPawn.Value;
        if (Open_.TryGetValue(player.Slot, out var old))
        {
            // то же меню открылось заново (после нажатия E) — курсор остаётся на месте, заморозка уже стоит
            old.Menu = this; old.Index = Math.Clamp(old.Index, 0, Math.Max(0, MenuOptions.Count - 1)); old.Dirty = true; old.Touched = DateTime.UtcNow;
            return;
        }
        var st = new State { Menu = this, Prev = player.Buttons };
        if (pawn is { IsValid: true })
        {
            st.Move = pawn.MoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : pawn.MoveType;
            SetMove(pawn, MoveType_t.MOVETYPE_NONE);
        }
        Open_[player.Slot] = st;
    }

    public void OpenToAll()
    {
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false }) Open(p);
    }

    private static void SetMove(CCSPlayerPawn pawn, MoveType_t t)
    {
        pawn.MoveType = t; pawn.ActualMoveType = t;
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
    }

    private static void Close(CCSPlayerController? p, int slot, State st)
    {
        Open_.Remove(slot);
        if (p is not { IsValid: true }) return;
        var pawn = p.PlayerPawn.Value;
        if (pawn is { IsValid: true } && pawn.MoveType == MoveType_t.MOVETYPE_NONE) SetMove(pawn, st.Move);
        p.PrintToCenterHtml(" ", 1);
    }

    private static void Tick()
    {
        if (Open_.Count == 0) return;
        foreach (var slot in Open_.Keys.ToArray())
        {
            var st = Open_[slot];
            CCSPlayerController? p = null;
            try
            {
            p = Utilities.GetPlayerFromSlot(slot);
            var pawn = p?.PlayerPawn.Value;
            if (p is not { IsValid: true } || pawn is not { IsValid: true } || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE
                || (DateTime.UtcNow - st.Touched).TotalSeconds > IdleClose)
            { Close(p, slot, st); continue; }

            var b = p.Buttons; var pressed = b & ~st.Prev; st.Prev = b;
            var opts = st.Menu.MenuOptions;
            if (pressed != 0) st.Touched = DateTime.UtcNow;
            if ((pressed & (PlayerButtons.Scoreboard | PlayerButtons.Reload)) != 0) { Close(p, slot, st); continue; }
            if (opts.Count > 0)
            {
                if ((pressed & PlayerButtons.Forward) != 0) { st.Index = (st.Index - 1 + opts.Count) % opts.Count; st.Dirty = true; }
                if ((pressed & PlayerButtons.Back) != 0) { st.Index = (st.Index + 1) % opts.Count; st.Dirty = true; }
                if ((pressed & PlayerButtons.Use) != 0)
                {
                    var o = opts[Math.Clamp(st.Index, 0, opts.Count - 1)];
                    if (!o.Disabled)
                    {
                        var who = p;
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
            catch { Open_.Remove(slot); }
        }
    }

    // ---------- вид ----------
    private static readonly Regex Tags = new("<[^>]+>", RegexOptions.Compiled);
    private const string Gold = "#ffcf40", Dim = "#8b93a1", Txt = "#e8ebf0", On = "#3ddc97", Off = "#ff5d5d", Na = "#5b6270";

    private static string Clean(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s) if (ch >= ' ' && ch != '[' && ch != ']') sb.Append(ch);
        return sb.ToString().Trim();
    }
    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    // «Здоровье <font color='#3cdc3c'>ВКЛ</font>» → название и состояние
    private static (string Name, string State) Split(string text)
    {
        var plain = Clean(Tags.Replace(text, ""));
        foreach (var s in new[] { "ВКЛ", "ВЫКЛ", "НЕТ ДОСТУПА", "ON", "OFF", "NO ACCESS" })
            if (plain.EndsWith(" " + s, StringComparison.Ordinal)) return (plain[..^(s.Length + 1)].Trim(), s);
        return (plain, "");
    }

    private static string Icon(string name)
    {
        var n = name.ToLowerInvariant();
        if (n.Contains("регенер") || n.Contains("реген")) return "↻";
        if (n.Contains("вампир")) return "♦";
        if (n.Contains("здоров") || n.Contains("health")) return "♥";
        if (n.Contains("брон") || n.Contains("armor")) return "■";
        if (n.Contains("деньг") || n.Contains("money")) return "$";
        if (n.Contains("шприц") || n.Contains("healthshot")) return "+";
        if (n.Contains("zeus")) return "ϟ";
        if (n.Contains("сап") || n.Contains("defuse")) return "✂";
        if (n.Contains("флеш") || n.Contains("гранат")) return "✦";
        return "•";
    }

    private static string Render(State st)
    {
        var m = st.Menu; var opts = m.MenuOptions;
        var group = Clean(Tags.Replace(m.Title, ""));
        var sb = new StringBuilder();
        sb.Append($"<font class='fontSize-l' color='{Gold}'>TASHER</font><font class='fontSize-l' color='{Txt}'> · {Esc(group)}</font><br>");
        sb.Append($"<font class='fontSize-s' color='{Dim}'>бонусы привилегии</font><br>");
        if (opts.Count == 0) sb.Append($"<font color='{Dim}'>бонусов нет</font><br>");
        int first = Math.Clamp(st.Index - Visible / 2, 0, Math.Max(0, opts.Count - Visible));
        for (int i = first; i < Math.Min(opts.Count, first + Visible); i++)
        {
            var (name, state) = Split(opts[i].Text);
            var sel = i == st.Index;
            var sc = state is "ВКЛ" or "ON" ? On : state is "ВЫКЛ" or "OFF" ? Off : Na;
            var mark = state is "ВКЛ" or "ON" ? "● ВКЛ" : state is "ВЫКЛ" or "OFF" ? "○ ВЫКЛ" : state.Length > 0 ? "нет доступа" : "";
            sb.Append(sel ? $"<font color='{Gold}'>▶ </font>" : "&nbsp;&nbsp;&nbsp;");
            sb.Append($"<font color='{(sel ? Gold : Dim)}'>{Icon(name)} </font>");
            sb.Append($"<font color='{(opts[i].Disabled ? Na : sel ? "#ffffff" : Txt)}'>{Esc(name)}</font>");
            if (mark.Length > 0) sb.Append($"<font color='{Dim}'>  ·  </font><font color='{sc}'>{mark}</font>");
            sb.Append("<br>");
        }
        if (opts.Count > Visible) sb.Append($"<font class='fontSize-s' color='{Dim}'>{st.Index + 1} из {opts.Count}</font><br>");
        sb.Append($"<font class='fontSize-s' color='{Dim}'>W/S — выбор   E — вкл/выкл   Tab — закрыть</font>");
        return sb.ToString();
    }
}
