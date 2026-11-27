"use strict";
// Проверка статистики на строках журнала с настоящего сервера (18.11.2026): node test/gamelog.js
const { DatabaseSync } = require("node:sqlite");
const GL = require("../lib/gamelog");
let fails = 0; const ok = (c, n, x) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + n + (c ? "" : " " + JSON.stringify(x))); };
const ME = "76561199597039737".replace(/.*/, String(76561197960265728n + 1618774009n)), P2 = String(76561197960265728n + 1556780734n);
const REAL = `L 11/18/2026 - 23:50:43: "Kev<0><BOT><>" connected, address "(unknown)"
L 11/18/2026 - 23:50:43: "Kev<0><BOT><>" entered the game
L 11/18/2026 - 23:50:43: "Kev<0><BOT>" switched from team <Unassigned> to <TERRORIST>
L 11/18/2026 - 23:50:43: World triggered "Game_Commencing"
L 11/18/2026 - 23:50:43: "Aspirant<1><BOT><>" connected, address "(unknown)"
L 11/18/2026 - 23:50:43: "Aspirant<1><BOT><>" entered the game
L 11/18/2026 - 23:50:43: "Aspirant<1><BOT>" switched from team <Unassigned> to <CT>
L 11/18/2026 - 23:52:28: "-NaiFF1337<2><[U:1:1618774009]><>" connected, address "1.2.3.4:27005"
L 11/18/2026 - 23:52:28: World triggered "Match_Start" on "de_dust2"
L 11/18/2026 - 23:52:29: "-NaiFF1337<2><[U:1:1618774009]><>" entered the game
L 11/18/2026 - 23:52:30: World triggered "Warmup_Start"
L 11/18/2026 - 23:52:33: "-NaiFF1337<2><[U:1:1618774009]>" switched from team <Unassigned> to <TERRORIST>
L 11/18/2026 - 23:52:33: "Kev<0><BOT><TERRORIST>" disconnected (reason "NETWORK_DISCONNECT_KICKED")
L 11/18/2026 - 23:52:40: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" [1 2 3] killed "Aspirant<1><BOT><CT>" [4 5 6] with "glock" (headshot)
L 11/18/2026 - 23:52:44: World triggered "Warmup_End"
L 11/18/2026 - 23:52:44: World triggered "Match_Start" on "de_dust2"
L 11/18/2026 - 23:52:44: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" triggered "Got_The_Bomb"
L 11/18/2026 - 23:53:05: World triggered "Round_Start"
L 11/18/2026 - 23:53:20: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" [-32 2091 -126] killed "Aspirant<1><BOT><CT>" [160 2370 -120] with "glock" (headshot)
L 11/18/2026 - 23:53:20: Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "0") (T "1")
L 11/18/2026 - 23:53:20: World triggered "Round_End"
L 11/18/2026 - 23:53:27: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" triggered "Got_The_Bomb"
L 11/18/2026 - 23:53:42: World triggered "Round_Start"
L 11/18/2026 - 23:54:29: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" triggered "Bomb_Begin_Plant" at bombsite A
L 11/18/2026 - 23:54:32: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" triggered "Planted_The_Bomb" at bombsite A
L 11/18/2026 - 23:54:35: "-NaiFF1337<2><[U:1:1618774009]><TERRORIST>" [630 2192 -94] killed "Aspirant<1><BOT><CT>" [258 2481 -121] with "ak47" (headshot)
L 11/18/2026 - 23:54:35: Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "0") (T "2")
L 11/18/2026 - 23:54:35: World triggered "Round_End"
L 11/18/2026 - 23:54:38: "-NaiFF1337<2><[U:1:1618774009]>" switched from team <TERRORIST> to <CT>
L 11/18/2026 - 23:54:38: "Squad<3><BOT><>" connected, address "(unknown)"
L 11/18/2026 - 23:54:38: "Squad<3><BOT><>" entered the game
L 11/18/2026 - 23:54:38: "Squad<3><BOT>" switched from team <Unassigned> to <TERRORIST>
L 11/18/2026 - 23:54:38: "Aspirant<1><BOT><CT>" disconnected (reason "NETWORK_DISCONNECT_KICKED")
L 11/18/2026 - 23:54:42: "Squad<3><BOT><TERRORIST>" triggered "Got_The_Bomb"
L 11/18/2026 - 23:54:57: World triggered "Round_Start"
L 11/18/2026 - 23:55:03: "Игрок Тест<4><[U:1:1556780734]><>" connected, address "5.6.7.8:27005"
L 11/18/2026 - 23:55:07: "Игрок Тест<4><[U:1:1556780734]><>" entered the game
L 11/18/2026 - 23:55:12: "Squad<3><BOT><TERRORIST>" triggered "Dropped_The_Bomb"
L 11/18/2026 - 23:55:15: "-NaiFF1337<2><[U:1:1618774009]><CT>" [64 -640 5] killed "Squad<3><BOT><TERRORIST>" [-980 -754 120] with "m4a1_silencer"
L 11/18/2026 - 23:55:15: Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "2")
L 11/18/2026 - 23:55:15: World triggered "Round_End"
L 11/18/2026 - 23:55:16: "Игрок Тест<4><[U:1:1556780734]>" switched from team <Unassigned> to <TERRORIST>
L 11/18/2026 - 23:55:16: "Squad<3><BOT><TERRORIST>" disconnected (reason "NETWORK_DISCONNECT_KICKED")
L 11/18/2026 - 23:55:22: "Игрок Тест<4><[U:1:1556780734]><TERRORIST>" triggered "Got_The_Bomb"
L 11/18/2026 - 23:55:37: World triggered "Round_Start"
L 11/18/2026 - 23:55:46: "Игрок Тест<4><[U:1:1556780734]><TERRORIST>" triggered "Dropped_The_Bomb"
L 11/18/2026 - 23:55:46: "-NaiFF1337<2><[U:1:1618774009]><CT>" [-365 1612 -127] killed "Игрок Тест<4><[U:1:1556780734]><TERRORIST>" [-465 93 -0] with "m4a1_silencer" (headshot)
L 11/18/2026 - 23:55:46: Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "2") (T "2")
L 11/18/2026 - 23:55:46: World triggered "Round_End"
L 11/18/2026 - 23:56:10: "Игрок Тест<4><[U:1:1556780734]><TERRORIST>" assisted killing "Squad<5><BOT><CT>"
L 11/18/2026 - 23:56:11: "Игрок Тест<4><[U:1:1556780734]><TERRORIST>" [1 1 1] committed suicide with "world"
L 11/18/2026 - 23:57:46: "-NaiFF1337<2><[U:1:1618774009]><CT>" disconnected (reason "NETWORK_DISCONNECT_DISCONNECT_BY_USER")`;
const db = new DatabaseSync(":memory:"); const ST = GL.makeStats(db);
const evs = REAL.split("\n").map(GL.parseLine);
ok(evs.filter(e => e && e.e === "kill").length === 5 && evs.filter(e => e && e.e === "kill" && e.hs).length === 4, "разбор: 5 убийств, 4 в голову", evs.filter(e => e && e.e === "kill").map(e => [e.a.n, e.v.n, e.w, e.hs]));
const k1 = evs.find(e => e && e.e === "kill"); ok(k1.a.sid === ME && k1.a.team === "t" && k1.v.bot && k1.v.team === "ct", "SteamID64 и команды из журнала", k1);
const u = evs.find(e => e && e.e === "enter" && e.a.n === "Игрок Тест"); ok(u && u.a.sid === P2, "ник с пробелом и кириллицей", u);
evs.forEach(ST.apply);
const me = ST.player(ME), p2 = ST.player(P2);
ok(me.k === 4 && me.hs === 3 && me.d === 0, "разминка не считается: 4 убийства, 3 хедшота", me);
ok(me.pt === 317 && p2.pt > 0, "время в игре: вход 23:52:29 — выход 23:57:46 = 5 мин 17 с; у того, кто ещё в игре, время идёт", [me.pt, p2.pt]);
ok(me.rw === 4 && me.rp === 4 && me.w[0][0] === "M4A1-S" && me.w[0][1] === 2 && me.w.length === 3, "раунды и оружие", [me.rw, me.rp, me.w]);
ok(me.k * 2 + me.hs + 2 /*бомба*/ + me.rw === me.pts, "очки: 4×2 + 3 + бомба 2 + 4 раунда = 17", me.pts);
ok(p2.d === 2 && p2.a === 1 && p2.k === 0, "второй игрок: смерть, самоубийство, помощь", p2);
const top = ST.top(GL.month(Date.UTC(2026, 10, 18, 12)));
ok(top.length === 2 && top[0].sid === ME && top[0].n === "-NaiFF1337", "рейтинг месяца", top.map(x => [x.n, x.pts]));
ok(ST.liveScore("-NaiFF1337") === null, "после выхода счёт на карте сброшен");
// перезапуск сервера: пауза в журнале закрывает сессии, а не считает простой как игру
const db2 = new DatabaseSync(":memory:"), S2 = GL.makeStats(db2);
["L 11/18/2026 - 10:00:00: \"A<2><[U:1:5]><CT>\" entered the game", "L 11/18/2026 - 10:10:00: \"A<2><[U:1:5]><CT>\" triggered \"Planted_The_Bomb\"", "L 11/18/2026 - 15:00:00: World triggered \"Match_Start\" on \"de_dust2\""].map(GL.parseLine).forEach(S2.apply);
ok(S2.player(String(76561197960265728n + 5n)).pt === 600, "долгая тишина в журнале: время не накручивается", S2.player(String(76561197960265728n + 5n)).pt);
// игрок молча стоит 20 минут — время идёт; затем сервер остановлен (сообщение systemd)
const db3 = new DatabaseSync(":memory:"), S3 = GL.makeStats(db3), sid3 = String(76561197960265728n + 7n);
["L 11/18/2026 - 10:00:00: \"B<2><[U:1:7]><CT>\" entered the game", "L 11/18/2026 - 10:20:00: \"B<2><[U:1:7]><CT>\" triggered \"Planted_The_Bomb\""].map(GL.parseLine).forEach(S3.apply);
S3.serverStop(new Date(2026, 10, 18, 10, 25).getTime());
ok(S3.player(sid3).pt === 25 * 60, "пауза 20 минут не обрывает время, остановка сервера закрывает сессию", S3.player(sid3).pt);
// номер игрока на сервере (для кика) и подключение до входа в игру
const cn = evs.find(e => e && e.e === "connect" && e.a.sid === P2); ok(cn && cn.a.uid === 4 && cn.a.n === "Игрок Тест", "подключение: SteamID и номер на сервере", cn);
ok(ST.online().has(P2) && ST.online().get(P2).uid === 4 && !ST.online().has(ME) && ST.sidByName("Игрок Тест") === P2, "кто сейчас на сервере: вышедший убран, оставшийся с номером", [...ST.online()]);
// «залго» и невидимые символы в нике
const zl = GL.parseLine("L 11/18/2026 - 23:59:00: \"Z\u0351\u0352\u0353a\u0300\u0301\u0302\u200bl\u202eg\u3164o<6><[U:1:9]><>\" entered the game");
ok(zl && zl.a.n === "Z\u0353\u00e0lgo" && zl.a.uid === 6, "ник очищен от залго и невидимых символов", zl && [...zl.a.n].map(c => c.codePointAt(0).toString(16)));
const empty = GL.parseLine("L 11/18/2026 - 23:59:00: \"\u3164\u200b<7><[U:1:10]><>\" entered the game"); ok(empty && empty.a.n === "Игрок", "пустой ник заменяется", empty && empty.a.n);
ok(GL.parseLine("garbage") === null && GL.parseLine("L 11/18/2026 - 23:55:12: something else") === null, "лишние строки пропускаются");
// окно сервера: стороны игроков (и ботов) и счёт матча
{
  const { DatabaseSync } = require("node:sqlite");
  const M = GL.makeStats(new DatabaseSync(":memory:"));
  const L = x => M.apply(GL.parseLine("L 11/19/2026 - 20:00:00: " + x));
  ok(JSON.stringify(GL.parseLine('L 11/19/2026 - 20:00:00: Team "CT" scored "7" with "5" players')) === JSON.stringify({ t: new Date(2026, 10, 19, 20).getTime(), e: "score", team: "ct", n: 7 }), "строка счёта команды");
  ok(GL.parseLine('L 11/19/2026 - 20:00:00: Started map "de_mirage" (CRC "0")').map === "de_mirage", "строка смены карты");
  L('World triggered "Warmup_Start"'); ok(M.match().warm, "разминка");
  L('World triggered "Match_Start" on "de_dust2"');
  L('"A<2><[U:1:11]><Unassigned>" switched from team <Unassigned> to <CT>');
  L('"B<3><[U:1:12]><CT>" switched from team <CT> to <TERRORIST>');
  L('"Bot<9><BOT><TERRORIST>" [0 0 0] killed "A<2><[U:1:11]><CT>" [1 1 1] with "glock"');
  L('Team "CT" scored "3" with "5" players'); L('Team "TERRORIST" scored "5" with "5" players');
  ok(M.teamOf("A") === "ct" && M.teamOf("B") === "t" && M.teamOf("Bot") === "t" && M.teamOf("Нет") === "", "стороны игроков и ботов");
  ok(JSON.stringify(M.match()) === JSON.stringify({ ct: 3, t: 5, warm: false }), "счёт матча", M.match());
  L('"B<3><[U:1:12]><TERRORIST>" switched from team <TERRORIST> to <Spectator>'); ok(M.teamOf("B") === "", "ушёл в наблюдатели — без команды");
  L('"A<2><[U:1:11]><CT>" disconnected (reason "x")'); ok(M.teamOf("A") === "", "вышел — сторона забыта");
  L('Started map "de_inferno"'); ok(M.match().ct === 0 && M.match().t === 0, "новая карта — счёт с нуля");
}
// очки рейтинга: смерть −3, ниже нуля не уходят, после нуля убийства считаются сразу
{
  const db2 = new DatabaseSync(":memory:"), M = GL.makeStats(db2), T = "L 11/20/2026 - 20:00:00: ";
  const L = x => M.apply(GL.parseLine(T + x));
  const pts = sid => db2.prepare("SELECT rpt FROM gstats WHERE sid=? AND period='all'").get(sid).rpt;
  L('World triggered "Match_Start" on "de_dust2"');
  const A = String(76561197960265728n + 21n), B = String(76561197960265728n + 22n);
  const kill = (a, b) => L(`"${a}<2><[U:1:${a === "A" ? 21 : 22}]><CT>" [0 0 0] killed "${b}<3><[U:1:${b === "A" ? 21 : 22}]><TERRORIST>" [1 1 1] with "ak47"`);
  kill("A", "B"); kill("A", "B");
  ok(pts(A) === 4 && pts(B) === 0, "убийство +2, смерть −3, но не ниже нуля", [pts(A), pts(B)]);
  kill("B", "A"); ok(pts(A) === 1, "смерть отнимает 3 очка", pts(A));
  kill("B", "A"); ok(pts(A) === 0, "очки не уходят в минус", pts(A));
  kill("A", "B"); ok(pts(A) === 2, "после нуля убийство сразу даёт очки", pts(A));
}
console.log(fails ? `\nОШИБОК: ${fails}` : "\nСтатистика считается верно"); process.exit(fails ? 1 : 0);
