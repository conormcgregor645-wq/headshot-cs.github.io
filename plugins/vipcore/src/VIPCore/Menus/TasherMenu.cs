// TASHER: меню !vip с тремя колонками-категориями в стиле закупки CS2 (center-HTML).
// Полноэкранный Panorama-экран с мышью требует отдельного Workshop HUD addon.
// W/S — по карточкам внутри колонки, A/D — между колонками, E — выбрать, Tab/R — закрыть. Пока меню открыто, игрок стоит на месте.
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
        public DateTime LastRender = DateTime.MinValue, Touched = DateTime.UtcNow;
        public string Html = string.Empty;
        public bool Dirty = true;
        public MoveType_t Move = MoveType_t.MOVETYPE_WALK;
    }

    private static readonly Dictionary<int, State> Open_ = new();
    private static BasePlugin? _hookedBy;
    private const int ContentRefreshSeconds = 4; // учитываем и изменения через публичный IMenu
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
                if ((pressed & PlayerButtons.Forward) != 0) { MoveSelection(st, 0, -1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Back) != 0) { MoveSelection(st, 0, 1); st.Dirty = true; }
                if ((pressed & PlayerButtons.Moveleft) != 0) { MoveSelection(st, -1, 0); st.Dirty = true; }
                if ((pressed & PlayerButtons.Moveright) != 0) { MoveSelection(st, 1, 0); st.Dirty = true; }
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
            if (st.Dirty || (DateTime.UtcNow - st.LastRender).TotalSeconds >= ContentRefreshSeconds)
            {
                st.Html = Render(st);
                st.LastRender = DateTime.UtcNow;
                st.Dirty = false;
            }
            // Как в CenterHtmlMenu CounterStrikeSharp, поддерживаем панель на экране каждый тик.
            p.PrintToCenterHtml(st.Html, 1);
            }
            catch { Close(p, slot, st); }
        }
    }

    // Три постоянные категории: карточки не перепрыгивают при переключении состояний.
    private static readonly string[] SectionNames = ["СНАРЯЖЕНИЕ", "БОЕВЫЕ", "БОНУСЫ"];
    private static readonly string[] SectionColors = ["#8cd0ff", "#ffcf40", "#b5e853"];

    private static int Category(string label)
    {
        var name = Clean(Tags.Replace(label, "")).ToLowerInvariant();
        if (name.Contains("брон") || name.Contains("здоров") || name.Contains("сап") ||
            name.Contains("armor") || name.Contains("health") || name.Contains("defuse")) return 0;
        if (name.Contains("гранат") || name.Contains("zeus") || name.Contains("зевс") ||
            name.Contains("флеш") || name.Contains("grenade") || name.Contains("шприц") ||
            name.Contains("healthshot")) return 1;
        return 2;
    }

    private static List<int>[] Sections(List<ChatMenuOption> opts)
    {
        var cols = new[] { new List<int>(), new List<int>(), new List<int>() };
        for (var i = 0; i < opts.Count; i++) cols[Category(opts[i].Text)].Add(i);
        return cols;
    }

    private static void MoveSelection(State st, int dx, int dy)
    {
        var cols = Sections(st.Menu.MenuOptions);
        var col = Array.FindIndex(cols, c => c.Contains(st.Index));
        if (col < 0) col = Array.FindIndex(cols, c => c.Count > 0);
        if (col < 0) return;
        var row = Math.Max(0, cols[col].IndexOf(st.Index));
        if (dx != 0)
        {
            for (var i = 1; i <= cols.Length; i++)
            {
                var next = (col + dx * i % cols.Length + cols.Length) % cols.Length;
                if (cols[next].Count == 0) continue;
                st.Index = cols[next][Math.Min(row, cols[next].Count - 1)];
                return;
            }
        }
        else if (dy != 0 && cols[col].Count > 0)
            st.Index = cols[col][(row + dy + cols[col].Count) % cols[col].Count];
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
    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    private static (string Name, string State) Split(string text)
    {
        var plain = Clean(Tags.Replace(text, ""));
        foreach (var v in new[] { "ВКЛ", "ВЫКЛ", "НЕТ ДОСТУПА", "ON", "OFF", "NO ACCESS" })
            if (plain.EndsWith(" " + v, StringComparison.OrdinalIgnoreCase))
                return (plain[..^(v.Length + 1)].Trim(), v);
        return (plain, "");
    }

    private static string Icon(string name)
    {
        var n = name.ToLowerInvariant();
        if (n.Contains("реген")) return "↻";
        if (n.Contains("вампир")) return "♦";
        if (n.Contains("здоров") || n.Contains("health")) return "♥";
        if (n.Contains("брон") || n.Contains("armor")) return "▣";
        if (n.Contains("деньг") || n.Contains("money")) return "$";
        if (n.Contains("шприц") || n.Contains("healthshot")) return "✚";
        if (n.Contains("zeus")) return "ϟ";
        if (n.Contains("сап") || n.Contains("defuse")) return "✂";
        if (n.Contains("флеш") || n.Contains("гранат")) return "✦";
        return "◆";
    }

    private static string Cell(List<ChatMenuOption> opts, int optionIndex, bool selected)
    {
        if (optionIndex < 0) return "<font color='#3b434d'> ──────────────── </font>";
        var (name, state) = Split(opts[optionIndex].Text);
        var enabled = state is "ВКЛ" or "ON";
        var disabled = opts[optionIndex].Disabled || state is "НЕТ ДОСТУПА" or "NO ACCESS";
        var status = disabled ? "✕" : enabled ? "●" : state.Length > 0 ? "○" : "◆";
        var color = disabled ? Na : selected ? Gold : enabled ? On : Txt;
        // Ограничиваем ширину карточки: длинные имена не портят остальные столбцы.
        if (name.Length > 14) name = name[..13] + "…";
        var label = $"{Icon(name)} {name}";
        label = Esc(label);
        var pad = new string(' ', Math.Max(0, 16 - name.Length));
        var content = $"{status} {label}{pad.Replace(" ", "&nbsp;")}";
        return selected
            ? $"<font color='{Gold}'>▣ </font><font color='#ffffff'><b>{content}</b></font><font color='{Gold}'> ◀</font>"
            : $"<font color='{color}'>  {content} </font>";
    }

    private static string Render(State st)
    {
        var opts = st.Menu.MenuOptions;
        var group = Esc(Clean(Tags.Replace(st.Menu.Title, "")));
        var cols = Sections(opts);
        var count = Math.Max(3, cols.Max(c => c.Count));
        var sb = new StringBuilder(1500);
        sb.Append($"<font class='fontSize-l' color='{Gold}'>T A S H E R  ·  V I P</font><br>");
        sb.Append($"<font color='{Txt}'>ПРИВИЛЕГИЯ: {group}</font><br>");
        sb.Append($"<font color='{Dim}'>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font><br>");
        for (var col = 0; col < 3; col++)
        {
            sb.Append($"<font class='fontSize-s' color='{SectionColors[col]}'>{SectionNames[col]}</font>");
            if (col < 2) sb.Append("<font color='#4c515a'>  │  </font>");
        }
        sb.Append("<br>");
        for (var row = 0; row < count; row++)
        {
            for (var col = 0; col < 3; col++)
            {
                var index = row < cols[col].Count ? cols[col][row] : -1;
                sb.Append(Cell(opts, index, index >= 0 && index == st.Index));
                if (col < 2) sb.Append("<font color='#4c515a'> │ </font>");
            }
            sb.Append("<br>");
        }
        sb.Append($"<font color='{Dim}'>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font><br>");
        if (opts.Count > 0)
        {
            var selected = opts[Math.Clamp(st.Index, 0, opts.Count - 1)];
            var (name, state) = Split(selected.Text);
            var status = selected.Disabled ? "НЕДОСТУПНО" : state.Length > 0 ? state : "ВЫБРАТЬ";
            sb.Append($"<font color='{Gold}'>{Esc(name)}</font><font color='{Dim}'>  ·  {Esc(status)}</font><br>");
        }
        else sb.Append($"<font color='{Dim}'>Доступных бонусов нет</font><br>");
        sb.Append($"<font class='fontSize-s' color='{Dim}'>W/S  РЯД   A/D  КАТЕГОРИЯ   E  ВЫБОР   TAB/R  ЗАКРЫТЬ</font>");
        return sb.ToString();
    }
}
