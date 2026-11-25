// Реклама сайта в чате: раз в AdvertMinutes минут — одно сообщение по кругу (призы рейтинга, кейсы, пропуск, магазин, кланы).
// Тексты — в конфиге (Adverts), {site} заменяется адресом сайта; цвета чата: {lime} {gold} {red} {blue} {grey} {white}.
// Пустой список или AdvertMinutes = 0 — реклама выключена.
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace TasherStyle;

public partial class TasherStyle
{
    private int _advertIdx;

    public static List<string> DefaultAdverts() => new()
    {
        "{gold}Рейтинг месяца:{white} 1 место — {gold}KING{white}, 2–3 — {gold}TITAN{white}, 4–10 — {lime}500 ₽{white} на баланс. Твоё место: {lime}!rank{white} · таблица на {lime}{site}",
        "Открывай {lime}кейсы{white} на {lime}{site}{white} — ножи, перчатки и скины сразу появляются у тебя в игре.",
        "{gold}Боевой пропуск:{white} 50 уровней наград — кейсы, эффекты, статусы и бусты ×2. Прогресс: {lime}!pass{white} · награды на {lime}{site}",
        "За игру тебе капают {lime}ТК{white} — трать их на кейсы, апгрейд и Фортуну на {lime}{site}{white}. Баланс: {lime}!tk",
        "Эффекты убийств, трассеры, цветной ник и тег в чате — в разделе {lime}«Оформление»{white} на {lime}{site}{white}. Настроить в игре: {lime}!menu",
        "Задания дня и недели дают ТК и опыт пропуска: {lime}!quests{white} · все задания на {lime}{site}",
        "Собери свой {lime}клан{white} на {lime}{site}{white} — лучшие кланы месяца делят призовой фонд в ТК.",
        "{gold}VIP, PREMIUM, ELITE…{white} — больше ТК за игру и бонусы на сервере. Подробнее на {lime}{site}",
    };

    private void LoadAdverts()
    {
        if (Config.AdvertMinutes <= 0) return;
        AddTimer(Config.AdvertMinutes * 60f, ShowAdvert, TimerFlags.REPEAT);
    }

    private void ShowAdvert()
    {
        var list = Config.Adverts;
        if (list.Count == 0) return;
        // на пустом сервере не пишем
        if (!Utilities.GetPlayers().Any(p => p is { IsValid: true, IsBot: false, IsHLTV: false })) return;
        var text = list[_advertIdx++ % list.Count]
            .Replace("{site}", Config.Site)
            .Replace("{lime}", $"{ChatColors.Lime}").Replace("{gold}", $"{ChatColors.Gold}").Replace("{red}", $"{ChatColors.Red}")
            .Replace("{blue}", $"{ChatColors.LightBlue}").Replace("{grey}", $"{ChatColors.Grey}").Replace("{white}", $"{ChatColors.Default}");
        Server.PrintToChatAll($"{Prefix}{text}");
    }
}
