"use strict";
// Достижения: сверка с сайтом и разовое начисление ТК. node test/achievements.js
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const { open, tx } = require("../lib/db");
const GL = require("../lib/gamelog");
const { makeAchievements, DEFS } = require("../lib/achievements");
let fails = 0; const ok = (c, n, x) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + n + (c ? "" : " " + JSON.stringify(x))); };

// ---------- 1. список на сервере совпадает с сайтом ----------
const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
function grab(name) { const i = html.indexOf("const " + name + "=["); let d = 0; const j = html.indexOf("[", i);
  for (let k = j; k < html.length; k++) { if (html[k] === "[") d++; else if (html[k] === "]") { d--; if (!d) return eval(html.slice(j, k + 1)); } } }
const site = Object.fromEntries([...grab("ACH_ART"), ...grab("ACH_NEW")].map(a => [a[1], a]));
const RAR = grab("RAR"), rarity = pct => RAR.find(r => pct >= r[0]);
const ti = html.indexOf("function targetOf"); const targetOf = eval("(" + html.slice(ti, html.indexOf("\n", ti)).replace(/^function targetOf/, "function") + ")");
const mi = html.indexOf("const ACH_METRIC={}"), blk = html.slice(mi, html.indexOf("function achReal", mi));
const siteTracked = new Set([...blk.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(n => site[n]));
const override = Object.fromEntries([...blk.matchAll(/"([^"]+)":\{f:.*,t:(\d+)\}[,}]*\)?;?$/gm)].map(m => [m[1], +m[2]]));
const srvNames = new Set(DEFS.filter(d => d.m !== "all").map(d => d.n)); // «Легенда сервера» сайт считает сам: все остальные
ok([...siteTracked].every(n => srvNames.has(n)) && [...srvNames].every(n => siteTracked.has(n)), "сервер и сайт считают одни и те же достижения",
  { onlySite: [...siteTracked].filter(n => !srvNames.has(n)), onlySrv: [...srvNames].filter(n => !siteTracked.has(n)) });
const badTk = DEFS.filter(d => !site[d.n] || rarity(site[d.n][3])[4] !== d.tk);
ok(!badTk.length, "награда ТК совпадает с сайтом", badTk.map(d => d.n));
const badT = DEFS.filter(d => d.m !== "all" && d.t !== (override[d.n] || targetOf(site[d.n])));
ok(!badT.length, "цели совпадают с сайтом", badT.map(d => [d.n, d.t]));

// ---------- 2. начисление ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-ach-")), db = open(path.join(dir, "t.db"));
GL.makeStats(db);
const NOW = Date.UTC(2026, 10, 20);
function addMoney(uid, cur, delta, kind, ref, meta) {
  const u = db.prepare(`SELECT ${cur} v FROM users WHERE id=?`).get(uid), after = u.v + delta;
  db.prepare(`UPDATE users SET ${cur}=? WHERE id=?`).run(after, uid);
  db.prepare("INSERT INTO ledger(user_id,cur,delta,after,kind,ref,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(uid, cur, delta, after, kind, ref || null, meta ? JSON.stringify(meta) : null, NOW);
  return after;
}
const A = makeAchievements({ db, tx: fn => tx(db, fn), addMoney, PTS: GL.PTS, now: () => NOW, log: { log() {} } });
const S1 = "76561190000000001", S2 = "76561190000000002";
const uid = db.prepare("INSERT INTO users(steamid,name,created_at,last_login,tk,rub) VALUES(?,?,?,?,?,?)").run(S1, "U1", NOW, NOW, 0, 0).lastInsertRowid;
for (const sid of [S1, S2]) db.prepare("INSERT INTO gplayers(sid,name,first_seen,last_seen) VALUES(?,?,?,?)").run(sid, "P", NOW, NOW);
// S1: 120 убийств, 100 хедшотов, 130 из АК, 12 закладок, 101 раунд; за прошлый месяц 5 200 очков
db.prepare("INSERT INTO gstats(sid,period,k,hs,rp,rw,pl,pt) VALUES(?,?,?,?,?,?,?,?)").run(S1, "all", 120, 100, 101, 50, 12, 3600 * 11);
db.prepare("INSERT INTO gstats(sid,period,k,hs,rw) VALUES(?,?,?,?,?)").run(S1, "2026-10", 2000, 1000, 200);
db.prepare("INSERT INTO gweapons(sid,w,k) VALUES(?,?,?)").run(S1, "AK-47", 130);
db.prepare("INSERT INTO gstats(sid,period,k) VALUES(?,?,?)").run(S2, "all", 100);

const got = A.check(S1).map(d => d.n).sort();
const want = ["Добро пожаловать", "Завсегдатай", "Золотая лихорадка", "Калаш", "Меткий глаз", "Новобранец", "Первые шаги", "Сапёр-новичок"].sort();
ok(JSON.stringify(got) === JSON.stringify(want), "выполненные достижения найдены по статистике", got);
const sum = want.reduce((s, n) => s + DEFS.find(d => d.n === n).tk, 0);
ok(db.prepare("SELECT tk FROM users WHERE id=?").get(uid).tk === sum, "ТК начислены на счёт", { sum });
ok(db.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='ach'").get().c === want.length, "каждая выплата — отдельная запись в журнале операций");
ok(A.check(S1).length === 0 && db.prepare("SELECT tk FROM users WHERE id=?").get(uid).tk === sum, "повторная проверка не платит второй раз");
db.prepare("UPDATE gstats SET k=1000 WHERE sid=? AND period='all'").run(S1);
ok(JSON.stringify(A.check(S1).map(d => d.n)) === JSON.stringify(["Боец"]), "новое достижение оплачивается, старые — нет");
ok(A.paid(S1).length === want.length + 1, "список выплаченных для сайта");
// S2 ещё не заходил на сайт — награда копится до первого входа
const r2 = A.check(S2).map(d => d.n);
ok(r2.includes("Новобранец") && (db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(S2) || {}).tk === r2.reduce((s, n) => s + DEFS.find(d => d.n === n).tk, 0), "без аккаунта на сайте — награда копится", r2);
ok(A.checkAll().n === 0, "проверка всех игроков ничего не платит повторно");
// показатели сайта: пропуск, задания, бонусы за игру, топ-10 месяца
db.prepare("INSERT INTO pass(sid,season,xp,prem) VALUES(?,?,?,?)").run(S1, "s1", 26 * 2000, 1);
db.prepare("INSERT INTO fun_count(sid,kind,n) VALUES(?,?,?),(?,?,?)").run(S1, "fb", 50, S1, "ace", 1);
for (let i = 0; i < 10; i++) db.prepare("INSERT INTO quest_prog(sid,day,qid,n,done) VALUES(?,?,?,?,1)").run(S1, "2026-11-" + (10 + i), "q", 1);
db.prepare("INSERT INTO awards(period,place,sid,name,pts,created_at) VALUES(?,?,?,?,?,?)").run("2026-10", 7, S1, "U1", 5000, NOW);
const r3 = A.check(S1).map(d => d.n).sort();
const want3 = ["В десятке", "Ветеран сезона", "Деловой", "Первая кровь", "Премиум-боец", "Сезонный боец", "Эйс"].sort();
ok(JSON.stringify(r3) === JSON.stringify(want3), "достижения пропуска, заданий, бонусов и рейтинга", r3);
ok(A.progress(S1).passlv === 26 && A.progress(S1).quests === 10, "прогресс для страницы достижений", A.progress(S1));

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок не прошли` : "\nДостижения считаются и оплачиваются верно");
process.exit(fails ? 1 : 0);
