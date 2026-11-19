"use strict";
// Проверка сервера: node test/smoke.js  (поднимает сервер на временной базе, сайт не нужен)
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 8191, B = "http://localhost:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-test-"));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>t</title></head><body></body></html>");
// поддельный клиент mysql: сохраняет присланный SQL в файл, чтобы проверить запись скинов в игру
const SQLLOG = path.join(dir, "sql.log"), FAKE = path.join(dir, "mysql"), PAINTS = path.join(dir, "paints.json");
// на проверку «есть ли таблица VIP-плагина» отвечает 1
fs.writeFileSync(FAKE, `#!/bin/sh\ncase "$*" in *kill_fx*) printf '1\\n4\\n'; exit 0;; *vip_users*|*tasher_style*) echo 1; exit 0;; esac\ncat >> "${SQLLOG}"\necho "-- END" >> "${SQLLOG}"\n`); fs.chmodSync(FAKE, 0o755);
fs.writeFileSync(path.join(dir, "wp.cnf"), "[client]\n");
fs.writeFileSync(PAINTS, JSON.stringify(Object.fromEntries(require("../data/wdata.json").flatMap(w => w.skins.map((sk, i) => [(require("../lib/wp").defOf(w.n)) + "|" + sk[0], [1000 + i]])))));
// поддельный journalctl: отдаёт строки журнала CS2 в формате JSON и «ждёт новых», как journalctl -f
const JFAKE = path.join(dir, "journalctl"), JLINES = path.join(dir, "j.jsonl");
const jl = [["L 11/18/2026 - 23:52:29: \"-NaiFF1337<2><[U:1:1618774009]><>\" entered the game", "cs2.sh"],
  ["L 11/18/2026 - 23:53:20: \"-NaiFF1337<2><[U:1:1618774009]><TERRORIST>\" [1 2 3] killed \"Aspirant<1><BOT><CT>\" [4 5 6] with \"glock\" (headshot)", "cs2.sh"],
  ["L 11/18/2026 - 23:53:20: Team \"TERRORIST\" triggered \"SFUI_Notice_Terrorists_Win\" (CT \"0\") (T \"1\")", "cs2.sh"],
  ["Stopped cs2.service - TASHER CS2 server.", "systemd"]].map(([m, id], i) => JSON.stringify({ __CURSOR: "c" + i, __REALTIME_TIMESTAMP: String((Date.now() - 1000 + i) * 1000), MESSAGE: m, SYSLOG_IDENTIFIER: id })).join("\n") + "\n";
fs.writeFileSync(JLINES, jl); fs.writeFileSync(JFAKE, `#!/bin/sh\nexec tail -n +1 -f "${JLINES}"\n`); fs.chmodSync(JFAKE, 0o755);
// дописать строку в «журнал» (как будто она только что появилась в консоли сервера)
let jn = 100; const jadd = m => fs.appendFileSync(JLINES, JSON.stringify({ __CURSOR: "c" + (jn++), __REALTIME_TIMESTAMP: String(Date.now() * 1000), MESSAGE: m, SYSLOG_IDENTIFIER: "cs2.sh" }) + "\n");
const lnow = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `L ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} - ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}: `; };
fs.writeFileSync(path.join(dir, "404.html"), "<!doctype html><title>404</title>нет такой страницы");
// поддельный RCON игрового сервера: записывает присланные команды
const RCMDS = []; const RPORT = 27931;
const rconSrv = require("node:net").createServer(c => { let buf = Buffer.alloc(0); c.on("data", d => { buf = Buffer.concat([buf, d]); while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) { const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString("utf8", 12, 4 + len - 2); buf = buf.subarray(4 + len);
  const pk = (i, t, b) => { const x = Buffer.from(b), p = Buffer.alloc(14 + x.length); p.writeInt32LE(10 + x.length, 0); p.writeInt32LE(i, 4); p.writeInt32LE(t, 8); x.copy(p, 12); return p; };
  const STATUS = "  id     time ping loss      state   rate adr name\n    1      BOT    0    0     active      0 'Aspirant'\n    2    00:05:01   30    0     active 786432 1.2.3.4:27005 '-NaiFF1337'\n    3    00:01:00   40    0     active 786432 5.6.7.8:27005 'Victim'\n";
  if (type === 3) c.write(pk(body === "rpass" ? id : -1, 2, "")); else { RCMDS.push(body); c.write(pk(id, 0, body === "status" ? STATUS : "ok\n")); } } }); }).listen(RPORT, "127.0.0.1");
let log = "";
function start(owners) { const p = spawn(process.execPath, [path.join(__dirname, "..", "app.js")], { env: { ...process.env, PORT, SITE_URL: B, DB_PATH: path.join(dir, "t.db"), STATIC_DIR: dir, DEV_LOGIN: "1", START_TK: "50000", OWNER_STEAMIDS: owners, WP_MYSQL_CNF: path.join(dir, "wp.cnf"), WP_PAINTS: PAINTS, MYSQL_BIN: FAKE, GAME_LOG_UNIT: "cs2.service", JOURNALCTL_BIN: JFAKE, GAME_SERVERS: `T|1.2.3.4:27015|127.0.0.1:${RPORT}`, GAME_RCON_PASS: "rpass" }, stdio: ["ignore", "pipe", "pipe"] }); p.stdout.on("data", d => log += d); p.stderr.on("data", d => log += d); return p; }
async function up() { for (let i = 0; i < 50; i++) { try { await fetch(B + "/api/health"); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); } } }
let srv = start("76561190000000001");
let fails = 0; const ok = (c, name, extra) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + name + (c ? "" : " " + JSON.stringify(extra))); };
async function login(sid) { const r = await fetch(`${B}/auth/dev?steamid=${sid}`, { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; }
const call = async (cookie, p, body, h = {}) => { const r = await fetch(B + p, body ? { method: "POST", headers: { cookie, "x-tasher": "1", "content-type": "application/json", ...h }, body: JSON.stringify(body) } : { headers: { cookie } }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };

(async () => {
  await up();
  const A = await login("76561190000000001"), P = await login("76561190000000002");
  let r = await call(A, "/api/me"); ok(r.j.user.role === "owner" && r.j.user.tk === 50000, "владелец создан, стартовые ТК", r.j);
  r = await call("", "/api/me"); ok(r.j.user === null, "гость без данных");
  r = await call("", "/api/cases/open", { k: "army", n: 1 }); ok(r.s === 401, "гость не может открыть кейс", r);
  r = await fetch(B + "/api/cases/open", { method: "POST", headers: { cookie: P, "content-type": "application/json" }, body: "{\"k\":\"army\"}" }); ok(r.status === 403, "запрос без служебного заголовка отклонён");
  r = await call(P, "/api/cases/open", { k: "army", n: 1 }, { origin: "https://evil.example" }); ok(r.s === 403, "запрос с чужого сайта отклонён", r);
  for (const n of [0, -3, 6, 1.5, "x", 1e9]) { r = await call(P, "/api/cases/open", { k: "army", n }); ok(r.s === 400 || (n === 1.5 && r.s === 200), "плохое количество " + n, r); }
  r = await call(P, "/api/cases/open", { k: "nope" }); ok(r.s === 404, "несуществующий кейс");
  // параллельные открытия: баланс не уходит в минус, списано ровно за успешные
  const price = (await call(P, "/api/cases")).j.cases.king; const before = (await call(P, "/api/me")).j.user.tk;
  const many = await Promise.all(Array.from({ length: 8 }, () => call(P, "/api/cases/open", { k: "sniper", n: 5 })));
  const good = many.filter(x => x.s === 200).length; const sn = (await call(P, "/api/cases")).j.cases.sniper;
  const me = (await call(P, "/api/me")).j;
  ok(good > 0 && me.user.tk === before - good * sn * 5 && me.items.length === good * 5, "параллельные открытия: списано и выдано ровно за успешные", [before, me.user.tk, good, sn, me.items.length]);
  ok(me.user.tk >= 0, "баланс не отрицательный", me.user.tk); ok(price > 50000, "king дороже баланса");
  await new Promise(z => setTimeout(z, 10500));
  r = await call(P, "/api/cases/open", { k: "king", n: 1 }); ok(r.s === 402, "не хватает ТК", r);
  // бесплатный кейс один раз в день, даже параллельно
  const d = await Promise.all(Array.from({ length: 6 }, () => call(A, "/api/cases/open", { k: "daily" })));
  ok(d.filter(x => x.s === 200).length === 1, "бесплатный кейс только один раз", d.map(x => x.s));
  // продажа: одна и та же вещь дважды и параллельно
  const itemsA = (await call(A, "/api/me")).j.items; const id = itemsA[0].id; const tk0 = (await call(A, "/api/me")).j.user.tk;
  const s2 = await Promise.all(Array.from({ length: 5 }, () => call(A, "/api/items/sell", { ids: [id, id] })));
  ok(s2.filter(x => x.s === 200).length === 1, "предмет продаётся один раз", s2.map(x => x.s));
  const tk1 = (await call(A, "/api/me")).j.user.tk; ok(tk1 === tk0 + s2.find(x => x.s === 200).j.sum, "начислено ровно за одну продажу");
  // чужой предмет
  const itemsP = (await call(P, "/api/me")).j.items;
  if (itemsP.length) { r = await call(A, "/api/items/sell", { ids: [itemsP[0].id] }); ok(r.s === 409, "чужой предмет продать нельзя", r);
    r = await call(A, "/api/upgrade", { ids: [itemsP[0].id], tk: 0, target: "AK-47|Redline|2|0" }); ok(r.s === 409, "чужой предмет в апгрейд нельзя", r); }
  // апгрейд
  r = await call(A, "/api/upgrade", { tk: -100, target: "AK-47|Redline|2|0" }); ok(r.s === 400, "отрицательная ставка", r);
  r = await call(A, "/api/upgrade", { tk: 10, target: "AK-47|Redline|2|0|bg" }); ok(r.s === 400, "несуществующая особая версия", r);
  r = await call(A, "/api/upgrade", { tk: 999999999, target: "AK-47|Redline|2|0" }); ok(r.s === 400 || r.s === 402, "ставка больше баланса", r);
  let wins = 0, N = 0, spent = 0; const tkA = (await call(A, "/api/me")).j.user.tk;
  for (let i = 0; i < 40; i++) { r = await call(A, "/api/upgrade", { tk: 100, target: "AK-47|Redline|2|0" }); if (r.s === 429) { await new Promise(z => setTimeout(z, 1700)); i--; continue; } if (r.s !== 200) break; N++; spent += 100; if (r.j.win) wins++; }
  const aft = (await call(A, "/api/me")).j; ok(aft.user.tk === tkA - spent, "апгрейд списывает ставку", [aft.user.tk, tkA, spent]); ok(N > 0 && wins <= N, `апгрейд: ${wins}/${N} побед при шансе ${r.j && r.j.chance ? r.j.chance.toFixed(2) : "?"}%`);
  // админка
  r = await call(P, "/api/admin/users"); ok(r.s === 403, "игрок не видит админку", r);
  r = await call(P, "/api/admin/balance", { user: 2, cur: "tk", delta: 1e6, reason: "x" }); ok(r.s === 403, "игрок не может начислить себе", r);
  r = await call(A, "/api/admin/balance", { user: 2, cur: "rub", delta: 300, reason: "тест" }); ok(r.s === 200 && r.j.user.balance === 300, "админ начисляет рубли", r);
  r = await call(A, "/api/admin/balance", { user: 2, cur: "rub", delta: -1000, reason: "тест" }); ok(r.s === 402, "нельзя списать больше, чем есть", r);
  r = await call(A, "/api/admin/balance", { user: 2, cur: "tk", delta: 5, reason: "" }); ok(r.s === 400, "нужна причина", r);
  r = await call(P, "/api/admin/role", { user: 2, role: "admin" }); ok(r.s === 403, "игрок не может выдать себе роль", r);
  r = await call(A, "/api/admin/role", { user: 2, role: "admin" }); ok(r.s === 200, "владелец выдаёт роль");
  r = await call(P, "/api/admin/users"); ok(r.s === 200, "новый админ видит список");
  r = await call(P, "/api/admin/role", { user: 1, role: "player" }); ok(r.s === 403, "админ не меняет роли");
  // статика
  for (const p of ["/server/app.js", "/.env", "/..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/tools/x"]) { const x = await fetch(B + p); ok(x.status === 404 || x.status === 400, "закрыт путь " + p, x.status); }
  let x = await fetch(B + "/", { headers: { cookie: A } }); let t = await x.text(); ok(/window\.TSRV=\{"user":\{/.test(t), "данные игрока вписаны в страницу");
  x = await fetch(B + "/"); t = await x.text(); ok(t.includes('window.TSRV={"user":null') && !/"items"|"loadout"|"myStats"/.test(t.slice(t.indexOf('window.TSRV'), t.indexOf('</script>', t.indexOf('window.TSRV')))), "гостю личные данные не отдаются");
  // повторная загрузка: страница и файлы не качаются заново, если не менялись
  x = await fetch(B + "/", { headers: { cookie: A } }); const et = x.headers.get("etag"); await x.text();
  x = await fetch(B + "/", { headers: { cookie: A, "if-none-match": et } }); ok(x.status === 304 && /private/.test(x.headers.get("cache-control")), "главная: 304, если данные не менялись", x.status);
  x = await fetch(B + "/", { headers: { "if-none-match": et } }); ok(x.status === 200, "гость не получает страницу игрока из кэша", x.status);
  await call(A, "/api/admin/balance", { user: 1, cur: "tk", delta: 7, reason: "тест кэша" });
  x = await fetch(B + "/", { headers: { cookie: A, "if-none-match": et } }); ok(x.status === 200, "главная: новая страница после изменения баланса", x.status);
  require("node:fs").writeFileSync(require("node:path").join(dir, "a.txt"), "hello");
  x = await fetch(B + "/a.txt"); const lm = x.headers.get("last-modified"); await x.text();
  x = await fetch(B + "/a.txt", { headers: { "if-modified-since": lm } }); ok(x.status === 304, "файлы: 304, если не менялись", x.status);
  // выход
  r = await fetch(B + "/auth/logout", { method: "POST", headers: { cookie: A } }); r = await call(A, "/api/me"); ok(r.j.user === null, "после выхода сессия не работает");
  r = await fetch(B + "/auth/steam?ret=//evil.example", { redirect: "manual" }); ok(r.status === 302 && decodeURIComponent(r.headers.get("location")).includes("return_to=" + B + "/auth/steam/return?ret=/") || /ret%3D%252F(&|$)/.test(r.headers.get("location")), "возврат после входа только на свой сайт", r.headers.get("location"));
  r = await fetch(B + "/auth/steam/return?openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561190000000001", { redirect: "manual" }); ok(r.status === 400, "поддельный ответ Steam не принимается", r.status);
  // поддержка
  const O = await login("76561190000000001"), U3 = await login("76561190000000003"), U4 = await login("76561190000000004");
  r = await call("", "/api/tickets"); ok(r.s === 401, "гость не видит тикеты", r.s);
  r = await call(U3, "/api/tickets", { r: "hack", subj: "тема", text: "достаточно длинный текст" }); ok(r.s === 400, "неизвестная тема отклонена", r);
  r = await call(U3, "/api/tickets", { r: "bug", subj: "a", text: "достаточно длинный текст" }); ok(r.s === 400, "слишком короткий заголовок", r);
  r = await call(U3, "/api/tickets", { r: "bug", subj: "Не работает <b>кнопка</b>", text: "Описание проблемы\u0000 с мусором\n\n\n\n\n\nи переносами" }); ok(r.s === 200 && r.j.id > 1000, "тикет создан", r);
  const tid = r.j.id;
  r = await call(U3, "/api/tickets"); ok(r.j.tickets.length === 1 && r.j.tickets[0].msgs[0].t.indexOf("\u0000") < 0 && !/\n{4}/.test(r.j.tickets[0].msgs[0].t) && r.j.tickets[0].sid === undefined, "игрок видит свой тикет, текст очищен", r.j);
  r = await call(U4, "/api/tickets"); ok(r.j.tickets.length === 0, "чужие тикеты не видны");
  r = await call(U4, "/api/tickets?all=1"); ok(r.s === 403, "игрок не видит все тикеты", r.s);
  r = await call(U4, "/api/tickets/reply", { id: tid, text: "чужой ответ" }); ok(r.s === 404, "нельзя писать в чужой тикет", r);
  r = await call(U4, "/api/tickets/reply", { id: tid, text: "ответ как поддержка", staff: true }); ok(r.s === 403, "игрок не отвечает от имени поддержки", r);
  r = await call(U4, "/api/tickets/state", { id: tid, state: "closed" }); ok(r.s === 403, "игрок не закрывает тикеты", r);
  r = await call(O, "/api/tickets?all=1"); ok(r.s === 200 && r.j.tickets.some(t => t.id === tid && t.sid === "76561190000000003"), "владелец видит все тикеты", r.j);
  r = await call(O, "/api/tickets/reply", { id: tid, text: "Привет, проверим", staff: true }); ok(r.s === 200, "владелец отвечает");
  r = await call(U3, "/api/tickets"); ok(r.j.tickets[0].st === "answered" && r.j.tickets[0].msgs.length === 2 && r.j.tickets[0].msgs[1].a === 1, "ответ виден игроку", r.j.tickets[0]);
  r = await call(U3, "/api/tickets/reply", { id: tid, text: "Спасибо" }); ok(r.s === 200, "игрок дополняет тикет");
  r = await call(O, "/api/tickets/state", { id: tid, state: "closed" }); ok(r.s === 200, "владелец закрывает тикет");
  r = await call(U3, "/api/tickets/reply", { id: tid, text: "ещё вопрос" }); ok(r.s === 409, "в закрытый тикет писать нельзя", r);
  r = await call(O, "/api/tickets/state", { id: "1001; DROP TABLE tickets", state: "closed" }); ok(r.s === 404, "неверный номер тикета", r);
  let made = 0, lim = 0; for (let i = 0; i < 4; i++) { r = await call(U3, "/api/tickets", { r: "other", subj: "Вопрос " + i, text: "Текст обращения номер " + i }); if (r.s === 200) made++; else if (r.s === 429) lim++; }
  ok(made === 2 && lim === 2, "не больше 3 обращений за 10 минут", [made, lim]);
  // проверка ответа Steam (без сети: вместо Steam отвечает заглушка)
  {
    const steam = require("../lib/steam"); const SITE = "https://tashercs.ru", ID = "https://steamcommunity.com/openid/id/76561190000000042";
    const mkq = over => new URLSearchParams({ "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "id_res", "openid.op_endpoint": "https://steamcommunity.com/openid/login", "openid.claimed_id": ID, "openid.identity": ID, "openid.return_to": SITE + "/auth/steam/return?ret=%2F", "openid.response_nonce": "2026-11-16T00:00:00Zabc", "openid.assoc_handle": "1234567890", "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle", "openid.sig": "c2ln", ...over });
    let asked = null; const yes = async (u, o) => { asked = { u, body: String(o.body) }; return { text: async () => "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n" }; }, no = async () => ({ text: async () => "ns:http://specs.openid.net/auth/2.0\nis_valid:false\n" });
    ok(await steam.verify(SITE, mkq({}), yes) === "76561190000000042" && asked.u === "https://steamcommunity.com/openid/login" && /openid\.mode=check_authentication/.test(asked.body) && /openid\.sig=c2ln/.test(asked.body), "Steam: правильный ответ принимается, подпись сверяется у Steam", asked);
    ok(await steam.verify(SITE, mkq({}), no) === null, "Steam: ответ с неверной подписью отклонён");
    ok(await steam.verify(SITE, mkq({ "openid.signed": "signed,op_endpoint,return_to,response_nonce,assoc_handle" }), yes) === null, "Steam: SteamID вне подписи отклонён");
    ok(await steam.verify(SITE, mkq({ "openid.identity": "https://steamcommunity.com/openid/id/76561190000000043" }), yes) === null, "Steam: разные identity и claimed_id отклонены");
    ok(await steam.verify(SITE, mkq({ "openid.op_endpoint": "https://evil.example/openid/login" }), yes) === null, "Steam: чужой адрес проверки отклонён");
    ok(await steam.verify(SITE, mkq({ "openid.return_to": "https://evil.example/auth/steam/return" }), yes) === null, "Steam: ответ для другого сайта отклонён");
    ok(await steam.verify(SITE, mkq({ "openid.claimed_id": "https://steamcommunity.com.evil.example/openid/id/76561190000000042", "openid.identity": "https://steamcommunity.com.evil.example/openid/id/76561190000000042" }), yes) === null, "Steam: поддельный адрес профиля отклонён");
    ok(await steam.verify(SITE, mkq({ "openid.mode": "cancel" }), yes) === null, "Steam: отменённый вход не принимается");
    const lu = new URL(steam.loginUrl(SITE, "/#shop")); ok(lu.origin + lu.pathname === "https://steamcommunity.com/openid/login" && lu.searchParams.get("openid.realm") === SITE && lu.searchParams.get("openid.return_to") === SITE + "/auth/steam/return?ret=" + encodeURIComponent("/#shop"), "Steam: ссылка на вход ведёт на steamcommunity.com и возвращает на свой сайт", String(lu));
  }
  // надеть / снять скин: хранится на сервере и уходит в базу WeaponPaints
  {
    const C = await login("76561190000000009"); await call(C, "/api/me");
    await call(A, "/api/me");
    let me = (await call(C, "/api/me")).j; let tries = 0;
    while (me.items.length < 6 && tries++ < 6) { await call(C, "/api/cases/open", { k: "daily" }); me = (await call(C, "/api/me")).j; if (me.items.length < 6) { const own = A; await call(own, "/api/admin/balance", { user: me.user.id, cur: "tk", delta: 200000, reason: "тест" }); const cs = (await call(C, "/api/cases")).j.cases; const k = Object.keys(cs).filter(k => cs[k] > 0).sort((a, b) => cs[a] - cs[b])[0]; await call(C, "/api/cases/open", { k, n: 5 }); me = (await call(C, "/api/me")).j; } }
    ok(Array.isArray(me.loadout) && me.loadout.length === 0, "новый игрок: ничего не надето", me.loadout);
    const both = me.items.find(i => !["AK-47", "Galil AR", "SG 553", "G3SG1", "Glock-18", "Tec-9", "MAC-10", "Sawed-Off", "M4A4", "M4A1-S", "FAMAS", "AUG", "SCAR-20", "USP-S", "P2000", "Five-SeveN", "MP9", "MAG-7"].includes(i.w) && !/Агент/.test(i.w));
    if (both) {
      fs.writeFileSync(SQLLOG, "");
      r = await call(C, "/api/equip", { id: both.id, team: "ct", on: true }); ok(r.s === 200 && r.j.loadout.some(x => x.id === both.id && x.team === "ct"), "скин надет за CT", r);
      r = await call(C, "/api/equip", { id: both.id, team: "t", on: true }); ok(r.s === 200 && r.j.loadout.length === 2, "тот же скин надет и за T", r.j);
      await new Promise(z => setTimeout(z, 700));
      const sql = fs.readFileSync(SQLLOG, "utf8"); const last = sql.split("-- END").filter(x => x.trim()).pop() || "";
      ok(/wp_player_skins/.test(last) && /'76561190000000009',2,/.test(last + sql) && /'76561190000000009',3,/.test(last), "скин записан в базу игры для обеих сторон", last.slice(0, 400));
      ok(/INSERT INTO wp_player_refresh \(steamid\) VALUES \('76561190000000009'\) ON DUPLICATE KEY UPDATE stamp = CURRENT_TIMESTAMP/.test(last) && last.indexOf("wp_player_refresh") > last.indexOf("COMMIT;"), "плагин получает просьбу применить скин сразу (wp_player_refresh, после записи)", last.slice(-500));
      r = (await call(C, "/api/me")).j; ok(r.loadout.length === 2, "надетое сохраняется на сервере", r.loadout);
      r = await call(C, "/api/equip", { id: both.id, team: "ct", on: false }); ok(r.s === 200 && r.j.loadout.length === 1 && r.j.loadout[0].team === "t", "снят за CT, за T остался", r.j);
      // продажа надетого снимает его и обновляет игру
      fs.writeFileSync(SQLLOG, "");
      r = await call(C, "/api/items/sell", { ids: [both.id] }); ok(r.s === 200, "надетый предмет продан", r);
      await new Promise(z => setTimeout(z, 700));
      r = (await call(C, "/api/me")).j; ok(r.loadout.length === 0, "проданный предмет снят", r.loadout);
      ok(/DELETE FROM wp_player_skins WHERE steamid='76561190000000009';/.test(fs.readFileSync(SQLLOG, "utf8")), "после продажи скин убран из игры", fs.readFileSync(SQLLOG, "utf8").slice(0, 300));
    } else ok(false, "нет подходящего предмета для проверки надевания", me.items.map(i => i.w));
    const tOnly = me.items.find(i => i.w === "AK-47" || i.w === "Glock-18");
    if (tOnly) { r = await call(C, "/api/equip", { id: tOnly.id, team: "ct", on: true }); ok(r.s === 400, "оружие террористов нельзя надеть за CT", r); }
    r = await call(C, "/api/equip", { id: "nope", team: "ct", on: true }); ok(r.s === 404, "чужой или несуществующий предмет не надевается", r);
    r = await call(C, "/api/equip", { id: me.items[0].id, team: "x", on: true }); ok(r.s === 400, "неверная сторона", r);
    const other = (await call(A, "/api/me")).j; if (other.items && other.items.length) { r = await call(C, "/api/equip", { id: other.items[0].id, team: "ct", on: true }); ok(r.s === 404, "чужой предмет не надеть", r); }
  }
  // статистика из журнала игрового сервера
  {
    const st = (await call("", "/api/stats")).j; const me = st.players.find(p => p.sid === "76561199579039737");
    ok(me && me.n === "-NaiFF1337" && me.k === 1 && me.hs === 1 && me.rw === 1 && me.pts === 4, "статистика: убийство, хедшот и победа из журнала", st);
    const pl = await call("", "/api/stats/player?sid=76561199579039737"); ok(pl.s === 200 && pl.j.player.k === 1 && pl.j.player.w[0][0] === "Glock-18", "профиль игрока со статистикой", pl.j);
    r = await call("", "/api/stats/player?sid=123"); ok(r.s === 400, "неверный SteamID", r.s);
    r = await call("", "/api/stats/player?sid=76561190000000077"); ok(r.s === 404, "не игравший игрок", r.s);
    const html = await (await fetch(B + "/")).text(); ok(/"stats":\{"period":"\d{4}-\d{2}","players":\[\{"sid":"76561199579039737"/.test(html), "рейтинг вписан в страницу");
  }
  // банлист, статусы, управление сервером
  {
    const O2 = await login("76561190000000001"), U5 = await login("76561190000000005");
    r = await call("", "/api/bans"); ok(r.s === 200 && Array.isArray(r.j.bans) && r.j.bans.length === 0, "банлист пуст", r.j);
    r = await call(U5, "/api/admin/ban", { target: "STEAM_1:1:55", reason: "Читы", days: 1 }); ok(r.s === 403, "игрок не может банить", r.s);
    r = await call(U5, "/api/admin/server"); ok(r.s === 403, "игрок не видит управление сервером", r.s);
    r = await call(U5, "/api/admin/grant", { target: "76561190000000005", tier: "KING", days: 30 }); ok(r.s === 403, "игрок не может выдать себе статус", r.s);
    // Victim подключается к серверу, админ банит его по SteamID — сразу кик по номеру
    jadd(lnow() + '"Victim<3><[U:1:111]><>" connected, address "5.6.7.8:27005"'); await new Promise(z => setTimeout(z, 600));
    RCMDS.length = 0; r = await call(O2, "/api/admin/ban", { target: "STEAM_1:1:55", reason: "Читы (WH)", days: 7 });
    ok(r.s === 200 && r.j.kicked === true && r.j.ban.n === "Victim" && RCMDS.some(c => /^kickid 3 "Бан до .* МСК\. Причина: Читы \(WH\)\. tashercs\.ru\/#bans"$/.test(c)), "бан игрока на сервере: сразу выгнан", [r, RCMDS]);
    // бан по нику того, кого сейчас нет; при входе на сервер — кик
    r = await call(O2, "/api/admin/ban", { target: "-naiff1337", reason: "Тест", days: 0 }); ok(r.s === 200 && r.j.ban.sid === "76561199579039737" && r.j.ban.perm && r.j.kicked === true && RCMDS.some(c => /^kickid 2 "Бан навсегда/.test(c)), "бан по нику (без учёта регистра): игрок есть в status — выгнан", [r, RCMDS]);
    r = await call(O2, "/api/admin/ban", { target: "76561199579039737", reason: "Тест", days: 1 }); ok(r.s === 409, "второй бан не выдаётся", r);
    await new Promise(z => setTimeout(z, 5200)); RCMDS.length = 0; jadd(lnow() + '"-NaiFF1337<2><[U:1:1618774009]><>" connected, address "1.2.3.4:27005"'); await new Promise(z => setTimeout(z, 800));
    ok(RCMDS.some(c => /^kickid 2 "Бан навсегда\. Причина: Тест\./.test(c)), "забаненный заходит — сразу кик", RCMDS);
    r = await call("", "/api/bans"); ok(r.j.bans.length === 2 && r.j.bans.every(b => b.active) && r.j.bans.some(b => b.sid2 === "STEAM_1:1:55"), "банлист виден всем", r.j);
    let html = await (await fetch(B + "/")).text(); ok(/"bans":\[\{"id":/.test(html) && /"statuses":\[/.test(html) && /"awards":\[/.test(html), "банлист, статусы и итоги вписаны в страницу");
    r = await call(O2, "/api/admin/unban", { id: r.j.bans.find(b => b.sid2 === "STEAM_1:1:55").id }); ok(r.s === 200 && r.j.ban.lifted, "разбан", r);
    // статусы
    r = await call(O2, "/api/admin/grant", { target: "76561190000000005", tier: "PREMIUM", days: 30 }); ok(r.s === 200 && r.j.statuses.some(s => s.sid === "76561190000000005" && s.t === "PREMIUM"), "статус выдан", r);
    html = await (await fetch(B + "/", { headers: { cookie: U5 } })).text(); ok(/"statuses":\[\{"sid":"76561190000000005","t":"PREMIUM"/.test(html), "статус виден на сайте");
    r = await call(O2, "/api/admin/revoke", { sid: "76561190000000005" }); ok(r.s === 200 && !r.j.statuses.length, "статус снят", r);
    // управление сервером
    r = await call(O2, "/api/admin/server"); ok(r.s === 200 && r.j.players.length === 3 && r.j.players.find(p => p.n === "-NaiFF1337").sid === "76561199579039737" && r.j.maps.length > 3, "админка: игроки на сервере с номерами и SteamID", r.j);
    RCMDS.length = 0; r = await call(O2, "/api/admin/server", { act: "say", text: "Всем привет; quit" }); ok(r.s === 200 && RCMDS.includes("say Всем привет quit"), "сообщение в чат", [r, RCMDS]);
    r = await call(O2, "/api/admin/server", { act: "kick", id: 3, n: "Victim", reason: "afk" }); ok(r.s === 200 && RCMDS.includes('kickid 3 "afk"'), "кик из админки", r);
    r = await call(O2, "/api/admin/server", { act: "map", map: "de_nuke" }); ok(r.s === 200 && RCMDS.includes("changelevel de_nuke"), "смена карты", r);
    r = await call(O2, "/api/admin/server", { act: "map", map: "quit" }); ok(r.s === 400, "карта не из списка", r);
  }
  // магазин: статус за рубли с баланса уходит в VIP-плагин игры
  {
    const B6 = await login("76561198000000006"), O3 = await login("76561190000000001");
    const me6 = (await call(B6, "/api/me")).j.user;
    r = await call(B6, "/api/shop/tier", { tier: "PREMIUM", days: 30 }); ok(r.s === 402, "статус без денег не покупается", r);
    r = await call(B6, "/api/shop/tier", { tier: "GOD", days: 30 }); ok(r.s === 400, "неизвестный статус", r.s);
    r = await call(B6, "/api/shop/tier", { tier: "VIP", days: 45 }); ok(r.s === 400, "неверный срок", r.s);
    await call(O3, "/api/admin/balance", { user: me6.id, cur: "rub", delta: 1000, reason: "тест магазина" });
    fs.writeFileSync(SQLLOG, ""); RCMDS.length = 0;
    r = await call(B6, "/api/shop/tier", { tier: "PREMIUM", days: 90 });
    ok(r.s === 200 && r.j.price === 539 && r.j.balance === 461 && r.j.statuses.some(x => x.sid === "76561198000000006" && x.t === "PREMIUM") && r.j.purchases[0].what === "Статус PREMIUM на 90 дней" && r.j.purchases[0].p === 539, "статус куплен: цена со скидкой 10% за 90 дней", r.j);
    await new Promise(z => setTimeout(z, 700));
    const sql = fs.readFileSync(SQLLOG, "utf8");
    ok(/INSERT INTO vip_users .*\(\d+,'[^']*',UNIX_TIMESTAMP\(\),0,'PREMIUM',\d{10}\)/.test(sql) && sql.includes(String(76561198000000006n - 76561197960265728n)), "статус записан в базу VIP-плагина", sql.slice(-600));
    ok(RCMDS.includes("css_reload_vip_player 76561198000000006"), "игроку на сервере статус применяется сразу", RCMDS);
    r = await call(B6, "/api/shop/tier", { tier: "PREMIUM", days: 30 }); ok(r.s === 200 && r.j.extended && r.j.balance === 262, "повторная покупка продлевает статус", r.j);
    const st = r.j.statuses.find(x => x.sid === "76561198000000006"); ok(st && Math.round((st.u - st.f) / 864e5) === 120, "срок: 90 + 30 дней", st);
    r = await call(B6, "/api/shop/tier", { tier: "VIP", days: 30, gift: "76561199579039737" }); ok(r.s === 200 && r.j.statuses.some(x => x.sid === "76561199579039737" && x.t === "VIP") && /в подарок -NaiFF1337/.test(r.j.what), "подарок другому игроку", r.j);
    r = await call(B6, "/api/shop/tier", { tier: "VIP", days: 30, gift: "76561198000000006" }); ok(r.s === 400, "подарок самому себе отклонён", r);
    // оформление профиля
    const cos = require("../data/cosmetics.json"), fr = cos.find(x => x.cat === "frame" && x.p <= 100);
    r = await call(B6, "/api/cos/eq", { cat: "frame", id: fr.id }); ok(r.s === 409, "некупленное не надеть", r);
    const bal0 = (await call(B6, "/api/me")).j.user.balance;
    r = await call(B6, "/api/shop/cos", { id: fr.id }); ok(r.s === 200 && r.j.balance === bal0 - fr.p && r.j.cos.own.includes(fr.id) && r.j.cos.eq.frame === fr.id, "рамка куплена и надета", r.j);
    r = await call(B6, "/api/shop/cos", { id: fr.id }); ok(r.s === 200 && r.j.balance === bal0 - fr.p, "повторно не списывается", r.j);
    r = await call(B6, "/api/cos/eq", { cat: "frame", id: null }); ok(r.s === 200 && !r.j.cos.eq.frame, "рамка снята", r.j);
    r = await call(B6, "/api/shop/cos", { id: "nope" }); ok(r.s === 400, "несуществующий предмет", r.s);
    r = (await call(B6, "/api/me")).j; ok(r.cos.own.length === 1 && r.purchases.length === 4 && r.purchases[0].what === "Оформление: " + fr.n, "покупки сохранены на сервере", r);
  }
  // Фортуна, джекпот, кланы, свой тег в чате
  {
    const W = await login("76561198000000009"), O4 = await login("76561190000000001");
    const wid = (await call(W, "/api/me")).j.user.id;
    r = await call(W, "/api/wheel/spin", {}); ok(r.s === 200 && Number.isInteger(r.j.i) && r.j.streak === 1 && r.j.wheel && !r.j.wheel.canSpin === !r.j.again, "Фортуна: приз выбран сервером", r.j);
    if (!r.j.again) { r = await call(W, "/api/wheel/spin", {}); ok(r.s === 409, "Фортуна: второй раз за день нельзя", r); }
    r = await call(W, "/api/jackpot"); ok(r.s === 200 && Array.isArray(r.j.hist) && r.j.rules.MAXP === 10, "джекпот: состояние раунда", r.j);
    r = await call(W, "/api/jackpot/bet", { ids: ["нет-такого"] }); ok(r.s === 409, "джекпот: чужой или несуществующий скин не поставить", r);
    const tkW = (await call(W, "/api/me")).j.user.tk;
    await call(O4, "/api/admin/balance", { user: wid, cur: "tk", delta: -tkW, reason: "тест кланов" });
    r = await call(W, "/api/clans/create", { name: "Тестовый клан", tag: "TST" }); ok(r.s === 402, "клан без 50 000 ТК не создать", r);
    await call(O4, "/api/admin/balance", { user: wid, cur: "tk", delta: 60000, reason: "тест кланов" });
    await call(O4, "/api/admin/balance", { user: wid, cur: "rub", delta: 100, reason: "тест тега" });
    fs.writeFileSync(SQLLOG, ""); RCMDS.length = 0;
    const tk0 = (await call(W, "/api/me")).j.user.tk;
    r = await call(W, "/api/clans/create", { name: "Тестовый клан", tag: "tst", color: "#5aa9ff" });
    ok(r.s === 200 && r.j.my && r.j.my.lead && r.j.clans.some(c => c.t === "TST" && c.members.length === 1) && r.j.me.tk === tk0 - 50000, "клан создан, списано 50 000 ТК", r.j);
    r = await call(W, "/api/cos/tag", { tag: "pro" }); ok(r.s === 200 && r.j.cos.tag === "PRO" && r.j.cos.eq.tag === "tag" && r.j.balance === 21, "свой тег в чате куплен за 79 ₽", r.j);
    await new Promise(z => setTimeout(z, 900));
    const sql = fs.readFileSync(SQLLOG, "utf8");
    ok(/INSERT INTO tasher_style \(steamid,chat_tag,name_color,score_tag,smoke,kill_fx,kill_snd,trail,tracer\) .*\(76561198000000009,'\{lime\}\[PRO\]','','PRO','','','','',''\)/.test(sql), "тег уходит в игру (TASHER Style)", sql.slice(-500));
    ok(RCMDS.includes("css_tasher_style_reload"), "сервер перечитывает стили сразу", RCMDS);
    r = await call(W, "/api/cos/eq", { cat: "tag", id: null }); ok(r.s === 200 && !r.j.cos.eq.tag && r.j.cos.tag === "PRO", "тег можно снять, не теряя его", r.j);
    await new Promise(z => setTimeout(z, 900));
    ok(/\(76561198000000009,'\{lightblue\}\[TST\]','','TST','','','','',''\)/.test(fs.readFileSync(SQLLOG, "utf8")), "без своего тега в чате — тег клана", fs.readFileSync(SQLLOG, "utf8").slice(-400));
    // эффекты в игре: эффект и звук убийства, трассеры, след гранат, цвет дыма
    await call(O4, "/api/admin/balance", { user: wid, cur: "rub", delta: 500, reason: "тест эффектов" });
    for (const id of ["kl_bolt", "sd_coin", "tc_3", "tr_2", "sm_1"]) { r = await call(W, "/api/shop/cos", { id }); ok(r.s === 200 && Object.values(r.j.cos.eq).includes(id), "куплено и надето: " + id, r.j); }
    await new Promise(z => setTimeout(z, 900));
    ok(/\(76561198000000009,'\{lightblue\}\[TST\]','','TST','255,107,139','bolt','coin','56,211,255','245,196,81'\)/.test(fs.readFileSync(SQLLOG, "utf8")), "эффекты, звук, трассеры, след гранат и дым уходят в игру", fs.readFileSync(SQLLOG, "utf8").slice(-400));
    r = await call(W, "/api/cos/eq", { cat: "tracer", id: null }); ok(r.s === 200 && !r.j.cos.eq.tracer, "трассеры снимаются", r.j);
    r = await call(W, "/api/cos/eq", { cat: "kill", id: "kl_spark" }); ok(r.s === 409, "некупленный эффект не надеть", r);
    let html = await (await fetch(B + "/", { headers: { cookie: W } })).text(); ok(/"clans":\{"clans":\[/.test(html) && /"jackpot":\{"round"/.test(html) && /"wheel":\{"canSpin"/.test(html) && /"earn":\{"base"/.test(html), "кланы, джекпот, Фортуна и ТК за игру вписаны в страницу");
  }
  // журнал сходится с балансом
  const lg = (await call(P, "/api/admin/ledger?user=2")).j.ledger; const u2 = (await call(P, "/api/me")).j.user;
  const lt = lg.find(x => x.cur === "tk"), lr = lg.find(x => x.cur === "rub");
  ok(lt && lt.after === u2.tk && lr && lr.after === u2.balance, "журнал сходится с балансом (" + lg.length + " записей)", [lt && lt.after, u2.tk, lr && lr.after, u2.balance]);
  // несуществующий адрес: человеку страница 404, программе короткий ответ, закрытые папки не раскрываются
  r = await fetch(B + "/shop", { headers: { accept: "text/html,*/*" } }); t = await r.text(); ok(r.status === 404 && t.includes("нет такой страницы"), "несуществующий адрес: страница 404", [r.status, t.slice(0, 60)]);
  r = await fetch(B + "/img/none.png", { headers: { accept: "image/*" } }); t = await r.text(); ok(r.status === 404 && t === "Not found", "несуществующий файл: короткий ответ", [r.status, t.slice(0, 60)]);
  r = await fetch(B + "/server/app.js", { headers: { accept: "text/html" } }); t = await r.text(); ok(r.status === 404 && t === "Not found", "закрытая папка не отдаёт страницу 404", [r.status, t.slice(0, 60)]);
  // чужие cookie с битой кодировкой не ломают сайт
  r = await fetch(B + "/", { headers: { cookie: "bad=%E0%A4%A; tsid=%; x=%zz" } }); ok(r.status === 200, "битые cookie: страница открывается", r.status);
  r = await call("bad=%E0%A4%A; tsid=%", "/api/me"); ok(r.s === 200 && r.j.user === null, "битые cookie: запрос отвечает как гостю", r);
  // владельцы берутся из настроек: после перезапуска с другим списком роли меняются
  await new Promise(z => { srv.once("exit", z); srv.kill(); }); srv = start("76561190000000002"); await up();
  const A2 = await login("76561190000000001"), P2 = await login("76561190000000002");
  r = await call(A2, "/api/me"); ok(r.j.user && r.j.user.role === "player", "убранный из настроек владелец теряет права", r.j.user && r.j.user.role);
  r = await call(P2, "/api/me"); ok(r.j.user && r.j.user.role === "owner", "новый владелец из настроек получает права", r.j.user && r.j.user.role);
  r = await call(A2, "/api/admin/users"); ok(r.s === 403, "бывший владелец не видит админку", r.s);
  console.log(fails ? `\nОШИБОК: ${fails}` : "\nВсе проверки пройдены");
  if (/Error|at /.test(log.replace(/TASHER server.*/, ""))) console.log("--- лог сервера ---\n" + log.slice(-1500));
  srv.kill(); rconSrv.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e, log); srv.kill(); process.exit(1); });
