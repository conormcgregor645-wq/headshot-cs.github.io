"use strict";
// Проверка сервера: node test/smoke.js  (поднимает сервер на временной базе, сайт не нужен)
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 8191, B = "http://localhost:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-test-"));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>t</title></head><body></body></html>");
// поддельный клиент mysql: сохраняет присланный SQL в файл, чтобы проверить запись скинов в игру
const SQLLOG = path.join(dir, "sql.log"), FAKE = path.join(dir, "mysql"), PAINTS = path.join(dir, "paints.json");
fs.writeFileSync(FAKE, `#!/bin/sh\ncat >> "${SQLLOG}"\necho "-- END" >> "${SQLLOG}"\n`); fs.chmodSync(FAKE, 0o755);
fs.writeFileSync(path.join(dir, "wp.cnf"), "[client]\n");
fs.writeFileSync(PAINTS, JSON.stringify(Object.fromEntries(require("../data/wdata.json").flatMap(w => w.skins.map((sk, i) => [(require("../lib/wp").defOf(w.n)) + "|" + sk[0], [1000 + i]])))));
fs.writeFileSync(path.join(dir, "404.html"), "<!doctype html><title>404</title>нет такой страницы");
let log = "";
function start(owners) { const p = spawn(process.execPath, [path.join(__dirname, "..", "app.js")], { env: { ...process.env, PORT, SITE_URL: B, DB_PATH: path.join(dir, "t.db"), STATIC_DIR: dir, DEV_LOGIN: "1", START_TK: "50000", OWNER_STEAMIDS: owners, WP_MYSQL_CNF: path.join(dir, "wp.cnf"), WP_PAINTS: PAINTS, MYSQL_BIN: FAKE }, stdio: ["ignore", "pipe", "pipe"] }); p.stdout.on("data", d => log += d); p.stderr.on("data", d => log += d); return p; }
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
  x = await fetch(B + "/"); t = await x.text(); ok(t.includes('window.TSRV={"user":null}'), "гостю данные не отдаются");
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
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e, log); srv.kill(); process.exit(1); });
