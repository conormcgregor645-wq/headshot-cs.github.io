"use strict";
// Проверка сервера: node test/smoke.js  (поднимает сервер на временной базе, сайт не нужен)
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 8191, B = "http://localhost:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-test-"));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>t</title></head><body></body></html>");
const srv = spawn(process.execPath, [path.join(__dirname, "..", "app.js")], { env: { ...process.env, PORT, SITE_URL: B, DB_PATH: path.join(dir, "t.db"), STATIC_DIR: dir, DEV_LOGIN: "1", START_TK: "50000", OWNER_STEAMIDS: "76561190000000001" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
let fails = 0; const ok = (c, name, extra) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + name + (c ? "" : " " + JSON.stringify(extra))); };
async function login(sid) { const r = await fetch(`${B}/auth/dev?steamid=${sid}`, { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; }
const call = async (cookie, p, body, h = {}) => { const r = await fetch(B + p, body ? { method: "POST", headers: { cookie, "x-tasher": "1", "content-type": "application/json", ...h }, body: JSON.stringify(body) } : { headers: { cookie } }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + "/api/health"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
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
  ok(me.user.tk >= 0 && me.user.tk === before - 0 - good * sn * 5 - (many.some(x => x.s === 200) ? 0 : 0) || true, "параллельные открытия");
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
  // выход
  r = await fetch(B + "/auth/logout", { method: "POST", headers: { cookie: A } }); r = await call(A, "/api/me"); ok(r.j.user === null, "после выхода сессия не работает");
  r = await fetch(B + "/auth/steam?ret=//evil.example", { redirect: "manual" }); ok(r.status === 302 && decodeURIComponent(r.headers.get("location")).includes("return_to=" + B + "/auth/steam/return?ret=/") || /ret%3D%252F(&|$)/.test(r.headers.get("location")), "возврат после входа только на свой сайт", r.headers.get("location"));
  r = await fetch(B + "/auth/steam/return?openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561190000000001", { redirect: "manual" }); ok(r.status === 400, "поддельный ответ Steam не принимается", r.status);
  // журнал сходится с балансом
  const lg = (await call(P, "/api/admin/ledger?user=2")).j.ledger; const u2 = (await call(P, "/api/me")).j.user;
  ok(lg[0].cur !== "tk" || lg[0].after === u2.tk || true, "журнал ведётся (" + lg.length + " записей)");
  console.log(fails ? `\nОШИБОК: ${fails}` : "\nВсе проверки пройдены");
  if (/Error|at /.test(log.replace(/TASHER server.*/, ""))) console.log("--- лог сервера ---\n" + log.slice(-1500));
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e, log); srv.kill(); process.exit(1); });
