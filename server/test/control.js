"use strict";
// Баны, статусы, итоги месяца и команды сервера: node test/control.js
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const { open, tx } = require("../lib/db");
const GL = require("../lib/gamelog");
const RCON = require("../lib/rcon");
const C = require("../lib/control");
let fails = 0; const ok = (c, n, x) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + n + (c ? "" : " " + JSON.stringify(x))); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-ctl-")), db = open(path.join(dir, "t.db"));
  const ST = GL.makeStats(db);
  let T = Date.UTC(2026, 9, 20, 12); // 20 октября 2026
  const fmt = t => { const d = new Date(t); const p = n => String(n).padStart(2, "0"); return `L ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} - ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}: `; };
  const sidN = n => String(76561197960265728n + BigInt(n));
  // 12 игроков в октябре: у игрока i — i убийств
  for (let i = 1; i <= 12; i++) {
    ST.apply(GL.parseLine(fmt(T) + `"P${i}<${i}><[U:1:${100 + i}]><>" entered the game`));
    for (let k = 0; k < i; k++) ST.apply(GL.parseLine(fmt(T + k * 1000) + `"P${i}<${i}><[U:1:${100 + i}]><CT>" [1 1 1] killed "Bot<90><BOT><TERRORIST>" [2 2 2] with "ak47"`));
    ST.apply(GL.parseLine(fmt(T + 20000) + `"P${i}<${i}><[U:1:${100 + i}]><CT>" disconnected (reason "x")`));
  }
  // «сейчас на сервере»: P5 с номером 5 и ещё один игрок с двойником-ником
  ST.apply(GL.parseLine(fmt(T + 30000) + `"P5<5><[U:1:105]><>" connected, address "1.1.1.1:1"`));
  const sent = []; let statusText = "";
  const rcon = { pass: "x", parseStatus: RCON.parseStatus, exec: async (s, p, cmd) => { sent.push(cmd); return cmd === "status" ? statusText : "ok"; } };
  const now = () => T;
  const CT = C.makeControl({ db, tx: fn => tx(db, fn), stats: ST, month: GL.month, rcon, servers: [{ host: "127.0.0.1", port: 27015 }], now, log: { log() {}, error() {} } });
  const admin = { id: 1, name: "Owner" };

  // ---------- SteamID ----------
  ok(C.toSid64("STEAM_0:1:809387004") === "76561199579039737" && C.toSid64("[U:1:1618774009]") === "76561199579039737" && C.toSid64("U:1:1618774009") === "76561199579039737" && C.toSid64("https://steamcommunity.com/profiles/76561199579039737") === "76561199579039737", "SteamID во всех видах");
  ok(C.toSid64("123") === null && C.toSid64("STEAM_1:2:5") === null && C.toSteam2("76561199579039737") === "STEAM_1:1:809387004", "неверный SteamID и обратное преобразование");
  ok(C.consoleText('a"; quit; say "b\nc', 50) === "a quit say b c", "текст для консоли без кавычек и ;", C.consoleText('a"; quit; say "b\nc', 50));

  // ---------- итоги месяца ----------
  ok(CT.runAwards(Date.UTC(2026, 9, 31, 12)) === null, "в течение месяца итогов нет (за сентябрь данных нет)");
  T = Date.UTC(2026, 10, 1, 0, 5); // 1 ноября 03:05 МСК
  ok(CT.runAwards(T) === "2026-10", "1-го числа подводятся итоги октября");
  ok(CT.runAwards(T + 600e3) === null, "итоги подводятся один раз");
  const aw = CT.listAwards(); ok(aw.length === 10 && aw[0].n === "P12" && aw[0].place === 1 && aw[9].n === "P3" && aw[0].period === "2026-10", "медали: топ-10 по очкам", aw.map(a => [a.place, a.n, a.pts]));
  let sts = CT.statuses();
  const kings = sts.filter(s => s.t === "KING").map(s => s.n).sort(), legends = sts.filter(s => s.t === "LEGEND").map(s => s.n).sort();
  ok(kings.join() === "P10,P11,P12" && legends.length === 7 && !sts.some(s => s.n === "P1" || s.n === "P2"), "места 1–3 — KING, 4–10 — LEGEND, остальным ничего", { kings, legends });
  ok(sts.every(s => s.u === T + 30 * 864e5), "статусы за итоги — на 30 дней");
  // через 31 день статусы истекают
  T += 31 * 864e5; ok(CT.statuses().length === 0, "через 30 дней статусы за итоги заканчиваются"); T -= 31 * 864e5;
  // январь -> итоги за декабрь прошлого года
  ok(C.prevMonth("2027-01") === "2026-12", "январь: итоги за декабрь");

  // ---------- статусы от админа ----------
  let r = CT.grant(admin, { target: "STEAM_1:0:1", tier: "VIP", days: 30 }); ok(!r.error && r.sid === sidN(2) && !r.extended, "выдан VIP по SteamID", r);
  r = CT.grant(admin, { target: "STEAM_1:0:1", tier: "VIP", days: 7 }); ok(r.extended, "повторная выдача продлевает срок", r);
  ok(CT.statuses().find(s => s.sid === sidN(2)).u === T + 37 * 864e5, "срок VIP: 30 + 7 дней");
  r = CT.grant(admin, { target: "P12", tier: "VIP", days: 30 }); sts = CT.statuses();
  ok(!r.error && sts.find(s => s.n === "P12").t === "KING", "у KING выдача VIP не понижает статус (показывается старший)", sts.find(s => s.n === "P12"));
  ok(CT.grant(admin, { target: "x", tier: "VIP", days: 30 }).error && CT.grant(admin, { target: "P1", tier: "GOD", days: 30 }).error && CT.grant(admin, { target: "P1", tier: "VIP", days: 0 }).error, "неверные данные отклоняются");
  r = CT.revoke(admin, sidN(112)); ok(!r.error && !r.statuses.some(s => s.n === "P12"), "снять статус (все действующие)", r);
  ok(CT.revoke(admin, sidN(112)).error, "повторно снять нечего");

  // ---------- баны ----------
  r = await CT.ban(admin, { target: "P7", reason: "Читы (WH)", days: 7 });
  ok(!r.error && r.ban.sid === sidN(107) && r.ban.n === "P7" && r.ban.active && r.ban.days === 7 && r.kicked === false, "бан по нику (игрок не на сервере — кика нет)", r);
  ok((await CT.ban(admin, { target: sidN(107), reason: "ещё", days: 1 })).code === 409, "второй активный бан не выдаётся");
  ok((await CT.ban(admin, { target: "P1", reason: "x", days: -1 })).error && (await CT.ban(admin, { target: "P1", reason: "", days: 1 })).error && (await CT.ban(admin, { target: "Нет такого", reason: "abc", days: 1 })).error, "неверные данные бана отклоняются");
  // P5 на сервере: бан сразу выгоняет его по номеру из status (по нику)
  statusText = "  id     time ping loss      state   rate adr name\n    1      BOT    0    0     active      0 'Bot'\n    5    00:10   20    0     active 786432 1.1.1.1:1 'P5'\n";
  sent.length = 0; r = await CT.ban(admin, { target: "STEAM_1:1:52", reason: 'Мат"; quit', days: 0 });
  ok(!r.error && r.ban.perm && r.kicked === true && sent.includes("status") && sent.some(c => /^kickid 5 "Бан навсегда\. Причина: Мат quit\. tashercs\.ru\/#bans"$/.test(c)), "бан игрока на сервере: сразу кик по номеру, кавычки и ; вырезаны", sent);
  // повторный вход забаненного: кик не чаще раза в 15 секунд
  sent.length = 0; T += 2e3; ok(await CT.enforce(sidN(105), 5) === false && !sent.length, "повторное событие в те же секунды — второй кик не шлётся");
  T += 4e3; ok(await CT.enforce(sidN(105), 5) === true && sent.some(c => c.startsWith("kickid 5 ")), "перезашёл — снова кик");
  // номер из журнала, если в status ника нет
  statusText = ""; T += 6e3; sent.length = 0; ok(await CT.enforce(sidN(105), 9) === true && sent.some(c => c.startsWith("kickid 9 ")), "нет в status — кик по номеру из журнала", sent);
  ok(await CT.enforce(sidN(103), 3) === false, "не забаненного не трогаем");
  const bl = CT.listBans(); ok(bl.length === 2 && bl[0].sid2 === "STEAM_1:1:52" && bl[0].by === "Owner", "банлист: SteamID в виде STEAM_1, кто выдал", bl);
  // снятие и истечение
  r = CT.unban(admin, bl[0].id); ok(!r.error && !r.ban.active && r.ban.lifted && !CT.activeBan(sidN(105)), "разбан");
  ok(CT.unban(admin, bl[0].id).code === 404, "повторный разбан — ошибка");
  T += 8 * 864e5; ok(!CT.activeBan(sidN(107)) && CT.listBans().find(b => b.sid === sidN(107)).active === false, "бан на 7 дней истекает");
  // ---------- мут и гег ----------
  {
    const sanc = []; const CT2 = C.makeControl({ db, tx: fn => tx(db, fn), stats: ST, month: GL.month, rcon, servers: [{ host: "127.0.0.1", port: 27015 }], now, log: { log() {}, error() {} }, onSanction: () => sanc.push(1) });
    sent.length = 0;
    r = await CT2.ban(admin, { target: "P8", reason: "Мат в голосовом", mins: 60, kind: "mute" });
    ok(!r.error && r.ban.kind === "mute" && r.ban.kindRu === "Мут" && r.ban.mins === 60 && r.ban.until === T + 3600e3 && r.kicked === false && !sent.some(c => c.startsWith("kickid")) && sanc.length === 1, "мут на час: без кика, игра узнаёт сразу", { r, sent });
    ok(!CT2.activeBan(sidN(108)) && CT2.activeMute(sidN(108)) && !CT2.activeGag(sidN(108)), "мут — не бан и не гег");
    ok((await CT2.ban(admin, { target: "P8", reason: "ещё", mins: 30, kind: "mute" })).code === 409, "второй мут не выдаётся");
    ok((await CT2.ban(admin, { target: "P8", reason: "ещё", mins: 30, kind: "silence" })).code === 409, "мут+гег при действующем муте — нельзя");
    r = await CT2.ban(admin, { target: "P8", reason: "Спам в чате", mins: 0, kind: "gag" });
    ok(!r.error && r.ban.perm && CT2.activeGag(sidN(108)), "гег навсегда поверх мута");
    r = await CT2.ban(admin, { target: "P9", reason: "Оскорбления", mins: 1440, kind: "silence" });
    ok(!r.error && CT2.activeMute(sidN(109)) && CT2.activeGag(sidN(109)), "мут и гег сразу");
    ok((await CT2.ban(admin, { target: "P9", reason: "x", mins: 10, kind: "wat" })).error && (await CT2.ban(admin, { target: "P9", reason: "xx", mins: -5, kind: "gag" })).error, "неверный тип или срок отклоняются");
    let S2 = CT2.activeSanctions(); const s8 = S2.find(x => x.sid === sidN(108)), s9 = S2.find(x => x.sid === sidN(109));
    ok(S2.length === 2 && s8.mute.until === T + 3600e3 && s8.gag.until === 0 && s9.mute.until === T + 86400e3 && s9.gag.until === T + 86400e3, "действующие муты и геги для игры", S2);
    ok(CT2.listBans().filter(b => b.kind !== "ban").length === 3 && CT2.listBans().some(b => b.kind === "silence" && b.kindRu === "Мут и гег"), "в банлисте видно тип наказания");
    // бан не выдаётся из-за мута, и наоборот
    r = await CT2.ban(admin, { target: "P9", reason: "Читы", days: 1 }); ok(!r.error && r.ban.kind === "ban", "бан при действующем муте выдаётся");
    // снятие и истечение
    const g = CT2.listBans().find(b => b.kind === "gag" && b.sid === sidN(108));
    sanc.length = 0; r = CT2.unban(admin, g.id); ok(!r.error && !CT2.activeGag(sidN(108)) && sanc.length === 1, "гег снят, игра узнаёт сразу");
    T += 3601e3; S2 = CT2.activeSanctions();
    ok(!CT2.activeMute(sidN(108)) && !S2.find(x => x.sid === sidN(108)) && S2.find(x => x.sid === sidN(109)), "мут на час истёк сам");
  }

  // ---------- команды сервера ----------
  statusText = "    1      BOT    0    0     active      0 'Bot'\n    5    00:10   20    0     active 786432 1.1.1.1:1 'P5'\n";
  const info = await CT.serverInfo(); ok(info.players.length === 2 && info.players[1].sid === sidN(105) && info.players[0].bot && info.maps.includes("de_mirage"), "список игроков для админки с SteamID", info);
  sent.length = 0; r = await CT.serverAct(admin, { act: "kick", id: 5, n: "P5", reason: "afk" }); ok(r.ok && sent.includes('kickid 5 "afk"'), "кик из админки", sent);
  r = await CT.serverAct(admin, { act: "kick", id: 5, n: "Другой" }); ok(r.code === 409, "кик: игрок сменился — отказ");
  r = await CT.serverAct(admin, { act: "kick", id: 7 }); ok(r.code === 409, "кик: такого номера нет");
  sent.length = 0; r = await CT.serverAct(admin, { act: "map", map: "de_inferno" }); ok(r.ok && sent[0] === "changelevel de_inferno", "смена карты");
  r = await CT.serverAct(admin, { act: "map", map: "de_inferno; quit" }); ok(r.error, "карта не из списка отклонена");
  sent.length = 0; r = await CT.serverAct(admin, { act: "restart" }); ok(r.ok && sent[0] === "mp_restartgame 3", "рестарт матча");
  sent.length = 0; r = await CT.serverAct(admin, { act: "say", text: 'Привет; quit "x"' }); ok(r.ok && sent[0] === "say Привет quit x", "сообщение в чат без лишних команд", sent);
  r = await CT.serverAct(admin, { act: "say", text: " ;; " }); ok(r.error, "пустое сообщение");
  r = await CT.serverAct(admin, { act: "rcon", cmd: "quit" }); ok(r.error, "произвольные команды запрещены");

  db.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\nОШИБОК: ${fails}` : "\nБаны, статусы, итоги месяца и команды работают"); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
