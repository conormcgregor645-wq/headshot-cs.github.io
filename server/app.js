"use strict";
// TASHER: сервер сайта. Node.js 22+, без сторонних библиотек.
// Запуск: node --env-file=.env app.js   (или через systemd, см. deploy/)
process.removeAllListeners("warning");
process.on("warning", w => { if (w.name !== "ExperimentalWarning") console.warn(w); });

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { open, tx } = require("./lib/db");
const steam = require("./lib/steam");
const G = require("./lib/game");
const WP = require("./lib/wp");
const A2S = require("./lib/a2s");
const GL = require("./lib/gamelog");
const JOURNAL = require("./lib/journal");
const RCON = require("./lib/rcon");
const { makeControl } = require("./lib/control");
const { cleanNick } = require("./lib/nick");
const VIP = require("./lib/vip");
const { makeEarn } = require("./lib/earn");
const { makeWheel } = require("./lib/wheel");
const { makeJackpot } = require("./lib/jackpot");
const { makeClans } = require("./lib/clans");
const STYLE = require("./lib/style");
const { makeQuests } = require("./lib/quests");
const { makeAchievements } = require("./lib/achievements");
const INFO = require("./lib/gameinfo");
const { makeMarket } = require("./lib/market");
const SKILLM = require("./lib/skill");
// UPD: лиги выключены, данные оставляем для возможного возврата без потери истории.
const LEAGUES_ENABLED = process.env.TASHER_LEAGUES_ENABLED === "1";
const { makeEvents } = require("./lib/events");
const { makePass } = require("./lib/pass");
const { makeFun } = require("./lib/fun");

// ---------- настройки ----------
const ENV = process.env;
const CFG = {
  port: +(ENV.PORT || 8080),
  host: ENV.HOST || "127.0.0.1",
  site: (ENV.SITE_URL || "http://localhost:8080").replace(/\/+$/, ""),
  db: ENV.DB_PATH || path.join(__dirname, "var", "tasher.db"),
  staticDir: path.resolve(ENV.STATIC_DIR || path.join(__dirname, "..")),
  steamKey: ENV.STEAM_API_KEY || "",
  owners: new Set((ENV.OWNER_STEAMIDS || "").split(/[,\s]+/).filter(Boolean)),
  startTk: Math.max(0, +(ENV.START_TK ?? 3000) || 0), // стартовый бонус ТК новым игрокам
  sessionDays: +(ENV.SESSION_DAYS || 30),
  devLogin: ENV.DEV_LOGIN === "1",
  // связь с WeaponPaints: файл настроек mysql (пусто — выключено) и файл номеров раскрасок
  wpCnf: ENV.WP_MYSQL_CNF || "",
  wpPaints: ENV.WP_PAINTS || "/var/lib/tasher/paints.json",
  mysqlBin: ENV.MYSQL_BIN || "mysql",
  // игровые серверы для списка на сайте: "Название|адрес для игроков|адрес для опроса;..."
  gameServers: A2S.parse(ENV.GAME_SERVERS),
  gameRcon: ENV.GAME_RCON_PASS || "",
  // статистика: служба игрового сервера, консоль которой читаем из системного журнала (пусто — выключено)
  gameLogUnit: ENV.GAME_LOG_UNIT || "",
  journalBin: ENV.JOURNALCTL_BIN || "journalctl",
  statsBots: ENV.GAME_STATS_BOTS !== "0",
  // карты для смены из админки (пусто — стандартный список)
  gameMaps: (ENV.GAME_MAPS || "").split(/[,\s]+/).filter(Boolean),
};
const SECURE = CFG.site.startsWith("https://");
if (CFG.devLogin && SECURE) { console.error("DEV_LOGIN нельзя включать на боевом сайте (SITE_URL https)."); process.exit(1); }

const db = open(CFG.db);
// владельцы задаются только в настройках (OWNER_STEAMIDS): при запуске роли приводятся в соответствие с ними
{
  const own = [...CFG.owners].filter(s => /^\d{17}$/.test(s)), ph = own.map(() => "?").join(",");
  db.prepare("UPDATE users SET role='player' WHERE role='owner'" + (own.length ? ` AND steamid NOT IN (${ph})` : "")).run(...own);
  if (own.length) db.prepare(`UPDATE users SET role='owner' WHERE steamid IN (${ph})`).run(...own);
}
const now = () => Date.now();
const PAINTS_N = WP.loadPaints(CFG.wpPaints);
const STICKERS_N = WP.loadStickers(path.join(path.dirname(CFG.wpPaints), "stickers.json"));
// после записи скинов плагин сам применяет их в игре (таблица wp_player_refresh, см. lib/wp.js)
const wpSync = WP.makeSync({ cnf: CFG.wpCnf, bin: CFG.mysqlBin });
const STATS = GL.makeStats(db, { bots: CFG.statsBots });
// лига игрока сменилась — новый тег в чате игры (не чаще раза в 5 секунд)
let styleT = null;
const SKILL = SKILLM.makeSkill({ db, onLeague: () => { if (styleT) return; styleT = setTimeout(() => { styleT = null; styleSync(); }, 5000); styleT.unref(); } });
// ники на сайте тоже приводим к чистому виду
{ const fix = db.prepare("UPDATE users SET name=? WHERE id=?"); for (const r of db.prepare("SELECT id, name FROM users").all()) { const c = cleanNick(r.name); if (c !== r.name) fix.run(c, r.id); } }
// статусы -> VIP-плагин в игре (та же база, что и скины; после записи игроку на сервере статус применяется сразу)
let vipSync = () => null, styleSync = () => null;
const CTL = makeControl({ db, tx: fn => tx(db, fn), stats: STATS, month: GL.month, rcon: { pass: CFG.gameRcon, exec: A2S.rconExec, parseStatus: RCON.parseStatus }, servers: CFG.gameServers, maps: CFG.gameMaps, onStatusChange: () => { vipSync(); styleSync(); }, payRub: (sid, rub, what) => { const u = db.prepare("SELECT id FROM users WHERE steamid=?").get(sid); if (!u) return false; addMoney(u.id, "rub", rub, "award", "rating", { what }); return true; }, onSanction: () => infoSoon(true) });
vipSync = VIP.makeVipSync({ cnf: CFG.wpCnf, bin: CFG.mysqlBin, getStatuses: () => CTL.statuses(),
  reload: sid => CFG.gameServers.length && CFG.gameRcon ? A2S.rconExec(CFG.gameServers[0], CFG.gameRcon, "css_reload_vip_player " + sid, 3000) : null });
if (CFG.wpCnf && require.main === module) { setTimeout(() => vipSync(), 3000).unref(); setInterval(() => vipSync(), 60e3).unref(); } // раз в минуту: истёкшие статусы и выдачи, сделанные пока сервер был недоступен
const mskDay = (t = now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

// ---------- HTTP-помощники ----------
function send(res, code, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}
const fail = (res, code, msg, extra) => send(res, code, { error: msg, ...extra });
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

function readBody(req, limit = 32 * 1024) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on("data", c => { n += c.length; if (n > limit) { no(new HttpError(413, "Слишком большой запрос")); req.destroy(); } else ch.push(c); });
    req.on("end", () => { if (!n) return ok({}); try { ok(JSON.parse(Buffer.concat(ch).toString("utf8"))); } catch (e) { no(new HttpError(400, "Неверный JSON")); } });
    req.on("error", no);
  });
}
function cookies(req) {
  // чужие cookie с битой кодировкой не должны ронять запрос
  const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) { const v = p.slice(i + 1).trim(); try { o[p.slice(0, i).trim()] = decodeURIComponent(v); } catch (e) { o[p.slice(0, i).trim()] = v; } } });
  return o;
}
function clientIp(req) {
  const ra = req.socket.remoteAddress || "";
  if ((ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1") && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return ra;
}

// простая защита от спама запросами: N действий за окно на ключ
const RL = new Map();
function rateLimit(key, n, ms) {
  const t = now(); let a = RL.get(key); if (!a) RL.set(key, a = []);
  while (a.length && a[0] < t - ms) a.shift();
  if (a.length >= n) bad("Слишком часто, подожди немного", 429);
  a.push(t);
}
setInterval(() => { const t = now(); for (const [k, a] of RL) if (!a.length || a[a.length - 1] < t - 600e3) RL.delete(k); }, 60e3).unref();

// ---------- сессии ----------
const SID = "tsid";
function sessionUser(req) {
  const tok = cookies(req)[SID]; if (!tok || tok.length > 100) return null;
  const s = db.prepare("SELECT s.user_id, s.expires_at FROM sessions s WHERE s.token_hash=?").get(sha(tok));
  if (!s || s.expires_at < now()) return null;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  if (!u || u.banned) return null;
  return u;
}
function startSession(res, req, userId) {
  const tok = crypto.randomBytes(32).toString("base64url"); const t = now(), exp = t + CFG.sessionDays * 864e5;
  db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,ua) VALUES(?,?,?,?,?,?)").run(sha(tok), userId, t, exp, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 200));
  return `${SID}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CFG.sessionDays * 86400}${SECURE ? "; Secure" : ""}`;
}
setInterval(() => { try { db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now()); } catch (e) {} }, 3600e3).unref();

// ---------- деньги и предметы ----------
function addMoney(uid, cur, delta, kind, ref, meta) {
  if (!["tk", "rub"].includes(cur) || !Number.isInteger(delta)) throw new Error("bad money op");
  const u = db.prepare(`SELECT ${cur} AS v FROM users WHERE id=?`).get(uid);
  const after = u.v + delta; if (after < 0) bad(cur === "tk" ? `Не хватает ${(-after).toLocaleString("ru-RU")} ТК` : `Не хватает ${(-after).toLocaleString("ru-RU")} ₽`, 402);
  db.prepare(`UPDATE users SET ${cur}=? WHERE id=?`).run(after, uid);
  db.prepare("INSERT INTO ledger(user_id,cur,delta,after,kind,ref,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(uid, cur, delta, after, kind, ref || null, meta ? JSON.stringify(meta) : null, now());
  return after;
}
const insItem = db.prepare("INSERT INTO items(id,user_id,w,s,r,wear,st,sv,sp,fx,seed,src,src_ref,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'inv',?)");
function giveItem(uid, it, src, ref) {
  insItem.run(it.id, uid, it.w, it.s, it.r, it.wear, it.st ? 1 : 0, it.sv ? 1 : 0, it.sp || null, it.fx || 0, it.seed || 0, src, ref || null, now());
  if (it.sv && !it.stk) { const stk = souvenirStk(); if (stk) { it.stk = stk; db.prepare("UPDATE items SET stk=? WHERE id=?").run(JSON.stringify(stk), it.id); } }
  return it;
}

// Сувенирные предметы, как в игре, идут с золотыми наклейками турнира: две команды финала, автограф игрока и логотип турнира.
// Турнир и команды выбираются случайно при выдаче предмета; названия — из общего списка наклеек (img/stk.json).
const SOUV_EVENTS = [
  ["Cologne 2026", "IEM"], ["Austin 2025", "BLAST.tv"], ["Budapest 2025", "StarLadder"], ["Shanghai 2024", "Perfect World"],
  ["Copenhagen 2024", "PGL"], ["Paris 2023", "BLAST.tv"], ["Rio 2022", "IEM"], ["Antwerp 2022", "PGL"],
];
const SOUV_TEAMS = ["Natus Vincere", "FaZe Clan", "Vitality", "G2 Esports", "MOUZ", "Team Spirit", "The MongolZ", "Aurora", "FURIA", "Eternal Fire",
  "Team Liquid", "Astralis", "Heroic", "Virtus.pro", "Cloud9", "MIBR", "paiN Gaming", "Imperial Esports", "Apeks", "ENCE", "BIG", "3DMAX", "Falcons"];
let SOUV = null;
function souvenirPools() {
  if (SOUV) return SOUV;
  let names = [];
  try { names = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "img", "stk.json"), "utf8")).map(x => x[0]); } catch (e) {}
  const have = new Set(names);
  SOUV = SOUV_EVENTS.map(([e, org]) => {
    const tail = " (Gold) | " + e, teams = SOUV_TEAMS.filter(t => have.has(t + tail)).map(t => t + tail);
    const players = names.filter(n => n.endsWith(tail) && !/[,|]/.test(n.slice(0, -tail.length)) && !teams.includes(n) && !n.startsWith(org + " ("));
    return { org: have.has(org + tail) ? org + tail : null, teams, players };
  }).filter(x => x.org && x.teams.length >= 2 && x.players.length);
  return SOUV;
}
function souvenirStk() {
  const ev = souvenirPools(); if (!ev.length) return null;
  const pick = a => a[crypto.randomInt(0, a.length)];
  const e = pick(ev), t1 = pick(e.teams); let t2 = pick(e.teams); while (t2 === t1) t2 = pick(e.teams);
  return [t1, t2, pick(e.players), e.org].map(n => ({ n, wear: 0 })).concat([null]);
}
const pubItem = r => ({ id: r.id, w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, fx: r.fx || undefined, seed: r.seed, stk: stkOf(r), t: r.created_at });
function stkOf(r) { if (!r.stk) return undefined; try { const a = JSON.parse(r.stk); return Array.isArray(a) && a.some(Boolean) ? a : undefined; } catch (e) { return undefined; } }
function userItems(uid) { return db.prepare("SELECT * FROM items WHERE user_id=? AND state='inv' ORDER BY created_at").all(uid).map(pubItem); }
function takeItems(uid, ids, state) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => typeof x !== "string" || x.length > 40)) bad("Неверный список предметов");
  const uniq = [...new Set(ids)]; const rows = [];
  for (const id of uniq) {
    const r = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(id, uid);
    if (!r) bad("Предмет не найден или уже использован", 409);
    rows.push(r);
  }
  const t = now(); for (const r of rows) { db.prepare("UPDATE items SET state=?, closed_at=? WHERE id=?").run(state, t, r.id); db.prepare("DELETE FROM loadout WHERE item_id=?").run(r.id); }
  return rows;
}
// ---------- надетые скины ----------
const T_ONLY = new Set(["AK-47", "Galil AR", "SG 553", "G3SG1", "Glock-18", "Tec-9", "MAC-10", "Sawed-Off", "Агент T"]);
const CT_ONLY = new Set(["M4A4", "M4A1-S", "FAMAS", "AUG", "SCAR-20", "USP-S", "P2000", "Five-SeveN", "MP9", "MAG-7", "Агент CT"]);
const W_CAT = new Map(G.W.map(w => [w.n, w.c]));
const slotOf = w => { const c = W_CAT.get(w); return c === "knife" || c === "gloves" ? c : w; };
const teamsOf = w => T_ONLY.has(w) ? ["t"] : CT_ONLY.has(w) ? ["ct"] : ["ct", "t"];
const userLoadout = uid => db.prepare("SELECT team, item_id id FROM loadout WHERE user_id=? ORDER BY team, slot").all(uid).map(r => ({ team: r.team, id: r.id }));
function syncGame(u) {
  wpSync(u.steamid, () => db.prepare("SELECT l.team, i.w, i.s, i.wear, i.seed, i.st, i.stk FROM loadout l JOIN items i ON i.id=l.item_id WHERE l.user_id=? AND i.state='inv'").all(u.id)
    .map(r => ({ team: r.team, it: { w: r.w, s: r.s, wear: r.wear, seed: r.seed, st: !!r.st, stk: stkOf(r) } })));
}
const pubUser = u => ({ id: u.id, steamid: u.steamid, n: u.name || ("Player" + u.id), av: u.avatar, role: u.role, tk: u.tk, balance: u.rub, created: u.created_at, dailyUsed: u.daily_day === mskDay() });
const isAdmin = u => u && (u.role === "admin" || u.role === "owner");

// ---------- маршруты ----------
const R = { GET: new Map(), POST: new Map() };
const get = (p, f) => R.GET.set(p, f), post = (p, f) => R.POST.set(p, f);
function needUser(ctx) { if (!ctx.user) bad("Нужно войти через Steam", 401); return ctx.user; }
function needAdmin(ctx) { const u = needUser(ctx); if (!isAdmin(u)) bad("Нет доступа", 403); return u; }

get("/api/health", () => ({ ok: true, t: now() }));

get("/api/me", ctx => {
  if (!ctx.user) return { user: null };
  return { user: pubUser(ctx.user), items: userItems(ctx.user.id), loadout: userLoadout(ctx.user.id), cos: userCos(ctx.user), purchases: userPurchases(ctx.user.id), freeCases: freeCases(ctx.user.id), wheel: WHEEL.state(ctx.user), earn: EARN.today(ctx.user.steamid), quests: QUESTS.state(ctx.user.steamid), achPaid: (ACH.check(ctx.user.steamid), ACH.paid(ctx.user.steamid)), achProg: ACH.progress(ctx.user.steamid), pass: PASS.state(ctx.user.steamid) };
});

// надеть / снять предмет за сторону (ct или t)
post("/api/equip", ctx => {
  const u = needUser(ctx); rateLimit("eq:" + u.id, 30, 10e3);
  const id = typeof ctx.body.id === "string" && ctx.body.id.length <= 40 ? ctx.body.id : bad("Неверный предмет");
  const team = ["ct", "t"].includes(ctx.body.team) ? ctx.body.team : bad("Сторона: ct или t");
  const on = ctx.body.on !== false;
  const out = tx(db, () => {
    const it = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(id, u.id);
    if (!it) bad("Предмет не найден", 404);
    if (!teamsOf(it.w).includes(team)) bad(team === "ct" ? "Этот предмет только для террористов" : "Этот предмет только для спецназа");
    if (on) db.prepare("INSERT OR REPLACE INTO loadout(user_id,team,slot,item_id) VALUES(?,?,?,?)").run(u.id, team, slotOf(it.w), id);
    else db.prepare("DELETE FROM loadout WHERE user_id=? AND team=? AND item_id=?").run(u.id, team, id);
    return { loadout: userLoadout(u.id) };
  });
  syncGame(u);
  return out;
});

// кейсы из пропуска, которые можно открыть бесплатно: { k: сколько }
const freeCases = uid => Object.fromEntries(db.prepare("SELECT k, n FROM case_free WHERE user_id=? AND n>0").all(uid).map(r => [r.k, r.n]));
get("/api/cases", () => ({ cases: Object.fromEntries(G.CASES.map(c => [c.k, c.p])) }));

post("/api/cases/open", ctx => {
  const u = needUser(ctx); rateLimit("open:" + u.id, 8, 10e3);
  const c = G.CASE_BY_K.get(String(ctx.body.k || "")); if (!c) bad("Кейс не найден", 404);
  const nRaw = ctx.body.n === undefined ? 1 : ctx.body.n; if (!Number.isInteger(nRaw) || nRaw < 1 || nRaw > 5) bad("Можно открыть от 1 до 5 кейсов");
  const n = c.p ? nRaw : 1, fromPass = ctx.body.free === true;
  return tx(db, () => {
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
    if (fromPass) {
      const have = (db.prepare("SELECT n FROM case_free WHERE user_id=? AND k=?").get(u.id, c.k) || {}).n || 0;
      if (have < n) bad(have ? `Из пропуска осталось только ${have}` : "Бесплатных кейсов из пропуска нет", 409);
      db.prepare("UPDATE case_free SET n=n-? WHERE user_id=? AND k=?").run(n, u.id, c.k);
    } else if (!c.p) {
      if (fresh.daily_day === mskDay()) bad("Бесплатный кейс уже открыт сегодня", 409);
      db.prepare("UPDATE users SET daily_day=? WHERE id=?").run(mskDay(), u.id);
    }
    const price = fromPass ? 0 : c.p * n;
    const ref = "case:" + c.k + ":" + crypto.randomBytes(4).toString("hex");
    if (price) addMoney(u.id, "tk", -price, "case", ref, { k: c.k, n });
    const items = Array.from({ length: n }, () => giveItem(u.id, G.rollCase(c), fromPass ? "pass" : "case", c.k));
    const value = items.reduce((s, it) => s + G.itemValue(it), 0);
    db.prepare("INSERT INTO case_opens(user_id,case_k,n,price,value,created_at) VALUES(?,?,?,?,?,?)").run(u.id, c.k, n, price, value, now());
    const after = db.prepare("SELECT tk FROM users WHERE id=?").get(u.id).tk;
    return { items: items.map(it => ({ ...it, t: now() })), tk: after, price, freeCases: freeCases(u.id) };
  });
});

// наклейки на предмет: 5 слотов, в каждом {n: название наклейки, wear: 0..1} или null; надетый предмет сразу обновляется в игре
post("/api/items/stickers", ctx => {
  const u = needUser(ctx); rateLimit("stk:" + u.id, 30, 60e3);
  const id = typeof ctx.body.id === "string" && ctx.body.id.length <= 40 ? ctx.body.id : bad("Неверный предмет");
  const raw = ctx.body.stk; if (raw != null && (!Array.isArray(raw) || raw.length > 5)) bad("Неверные наклейки");
  const stk = Array.from({ length: 5 }, (_, i) => { const x = raw && raw[i]; if (!x) return null;
    const n = typeof x.n === "string" ? x.n.trim().slice(0, 120) : ""; if (!n) bad("Неверная наклейка");
    return { n, wear: Math.round(Math.min(1, Math.max(0, +x.wear || 0)) * 100) / 100 }; });
  const it = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(id, u.id); if (!it) bad("Предмет не найден", 404);
  if (it.sv) bad("На сувенирном предмете наклейки турнира, их нельзя менять", 409);
  const val = stk.some(Boolean) ? JSON.stringify(stk) : null;
  db.prepare("UPDATE items SET stk=? WHERE id=?").run(val, id);
  if (db.prepare("SELECT 1 FROM loadout WHERE user_id=? AND item_id=?").get(u.id, id)) syncGame(u);
  return { item: pubItem({ ...it, stk: val }) };
});

post("/api/items/sell", ctx => {
  const u = needUser(ctx); rateLimit("sell:" + u.id, 20, 10e3);
  const out = tx(db, () => {
    const rows = takeItems(u.id, ctx.body.ids, "sold");
    const sum = rows.reduce((s, r) => s + Math.max(1, G.itemValue(r)), 0);
    const tk = addMoney(u.id, "tk", sum, "sell", null, { ids: rows.map(r => r.id) });
    return { sold: rows.map(r => r.id), sum, tk };
  });
  syncGame(u); return out;
});

// ---------- торговая площадка ----------
const MARKET = makeMarket({ db, tx: fn => tx(db, fn), addMoney, itemValue: G.itemValue, catOf: w => W_CAT.get(w) || "" });
const mkCall = f => { try { return f(); } catch (e) { if (!(e instanceof HttpError) && Number.isInteger(e.code)) bad(e.message, e.code); throw e; } };
get("/api/market", ctx => { const g = k => String(ctx.query.get(k) || ""); return { ...MARKET.browse({ q: g("q"), cat: g("cat"), r: g("r"), sort: g("sort"), offset: +g("offset") || 0 }), feed: MARKET.feed(), fee: MARKET.FEE }; });
get("/api/market/my", ctx => { const u = needUser(ctx); return MARKET.mine(u); });
post("/api/market/list", ctx => {
  const u = needUser(ctx); rateLimit("mk:" + u.id, 20, 60e3);
  const r = mkCall(() => MARKET.listItem(u, ctx.body.id, ctx.body.price));
  if (r.unequipped) syncGame(u);
  return { ...r, items: userItems(u.id), loadout: userLoadout(u.id), my: MARKET.mine(u) };
});
post("/api/market/cancel", ctx => {
  const u = needUser(ctx); rateLimit("mk:" + u.id, 20, 60e3);
  mkCall(() => MARKET.cancel(u, ctx.body.id));
  return { items: userItems(u.id), my: MARKET.mine(u) };
});
post("/api/market/buy", ctx => {
  const u = needUser(ctx); rateLimit("mkb:" + u.id, 10, 10e3);
  const r = mkCall(() => MARKET.buy(u, ctx.body.id, ctx.body.price));
  return { tk: r.tk, item: r.item, price: r.price, items: userItems(u.id), my: MARKET.mine(u) };
});

post("/api/upgrade", ctx => {
  const u = needUser(ctx); rateLimit("up:" + u.id, 6, 10e3);
  const t = G.upTarget(ctx.body.target); if (!t) bad("Цель апгрейда не найдена");
  const tkStake = Math.floor(+ctx.body.tk || 0); if (!(tkStake >= 0 && tkStake <= 1e9)) bad("Неверная ставка ТК");
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : []; if (ids.length > 6) bad("Можно поставить до 6 скинов");
  const out = tx(db, () => {
    const rows = ids.length ? takeItems(u.id, ids, "upgraded") : [];
    const stake = rows.reduce((s, r) => s + G.itemValue(r), 0) + tkStake;
    if (stake <= 0) bad("Выбери ставку");
    if (t.p <= stake * 1.05) bad("Цель должна стоить дороже ставки");
    if (tkStake) addMoney(u.id, "tk", -tkStake, "upgrade", null, { target: ctx.body.target });
    const chance = G.upChance(stake, t.p), roll = G.rnd() * 100, win = roll < chance;
    let item = null; if (win) item = giveItem(u.id, G.upItem(t), "upgrade", ctx.body.target);
    const tk = db.prepare("SELECT tk FROM users WHERE id=?").get(u.id).tk;
    return { win, chance, roll, item: item && { ...item, t: now() }, tk, stake, price: t.p };
  });
  if (ids.length) syncGame(u);
  return out;
});

// игровые серверы: опрашиваем раз в 10 секунд, сайту отдаём последний результат
let GS = null;
async function pollServers() {
  if (!CFG.gameServers.length) return;
  try {
    // забаненный на сервере (например, бан выдан, пока сервер был недоступен) — выгоняем
    const r = await A2S.poll(CFG.gameServers, 1500, CFG.gameRcon, (s, st) => { for (const p of st) if (!p.bot) { const sid = STATS.sidByName(p.n); if (sid) CTL.enforce(sid, p.id); } });
    // счёт на карте и сторона игрока — из журнала (журнал у нас один: первого сервера)
    for (const s of r) for (const p of s.list) { const x = STATS.liveScore(p.n); if (x) { p.k = x.k; p.d = x.d; } }
    if (r[0] && r[0].online && CFG.gameLogUnit) { for (const p of r[0].list) p.team = STATS.teamOf(p.n); r[0].score = STATS.match(); }
    GS = r;
  } catch (e) {}
}
if (CFG.gameServers.length && require.main === module) { pollServers(); setInterval(pollServers, 10e3).unref(); }
get("/api/servers", async () => { if (!GS && CFG.gameServers.length) await pollServers(); return { servers: GS || [] }; });

// ---------- статистика игроков ----------
// лига игрока: sr — сила, lg — номер лиги (null — калибровка), cl — сколько событий осталось до конца калибровки
const withSkill = p => { if (!p || !LEAGUES_ENABLED) return p; const k = SKILL.info(p.sid); return { ...p, sr: k.sr, lg: k.lg, cl: k.left, nx: k.next }; };
get("/api/leagues", () => LEAGUES_ENABLED ? SKILL.board(20) : { leagues: [], calib: 0, total: 0, top: [] });
let TOP_CACHE = { t: 0, period: "", v: null };
function statsTop(period) {
  if (TOP_CACHE.v && TOP_CACHE.period === period && now() - TOP_CACHE.t < 5000) return TOP_CACHE.v;
  const online = new Set((GS || []).flatMap(s => s.list.filter(p => !p.bot).map(p => p.n)));
  // надетое оформление для рейтинга: bg — фон профиля (виден в профиле), rbg — фон на подиуме, rrow — полоска в строке таблицы
  const look = new Map(); for (const r of db.prepare("SELECT steamid, cos_eq FROM users WHERE cos_eq LIKE '%\"bg\"%' OR cos_eq LIKE '%\"rbg\"%' OR cos_eq LIKE '%\"rrow\"%'").all()) {
    try { const e = JSON.parse(r.cos_eq), o = {}; for (const k of ["bg", "rbg", "rrow"]) if (typeof e[k] === "string") o[k] = e[k]; look.set(r.steamid, o); } catch (e) {} }
  const top = STATS.top(period, 200);
  const av = steamAvatars(top.map(p => p.sid));
  const v = top.map(p => withSkill({ ...p, on: online.has(p.n), ...(look.get(p.sid) || {}), ...(av.get(p.sid) ? { av: av.get(p.sid) } : {}) }));
  TOP_CACHE = { t: now(), period, v }; return v;
}
// Steam-аватары игроков рейтинга: с сайта (кто входил через Steam) — из базы, остальные — из Steam API раз в 6 часов (в фоне, не задерживая ответ)
const AV_CACHE = new Map(); let AV_BUSY = false;
function steamAvatars(sids) {
  const out = new Map(), stale = [], t = now();
  const rows = sids.length ? db.prepare(`SELECT steamid, avatar FROM users WHERE avatar<>'' AND steamid IN (${sids.map(() => "?").join(",")})`).all(...sids) : [];
  for (const r of rows) out.set(r.steamid, r.avatar);
  for (const s of sids) {
    if (out.has(s)) continue;
    const c = AV_CACHE.get(s);
    if (c) { if (c.av) out.set(s, c.av); if (t - c.t < 6 * 3600e3) continue; }
    stale.push(s);
  }
  if (stale.length && CFG.steamKey && !AV_BUSY && require.main === module) {
    AV_BUSY = true;
    steam.avatars(CFG.steamKey, stale).then(m => {
      for (const s of stale) AV_CACHE.set(s, { av: m.get(s) || (AV_CACHE.get(s) || {}).av || "", t: now() });
      if (m.size) TOP_CACHE.v = null;
    }).catch(() => {}).finally(() => { AV_BUSY = false; });
  }
  return out;
}
get("/api/stats", ctx => {
  const q = String(ctx.query.get("period") || ""); const period = /^\d{4}-\d{2}$/.test(q) || q === "all" ? q : GL.month(now());
  return { period, players: statsTop(period) };
});
get("/api/stats/player", ctx => {
  const sid = String(ctx.query.get("sid") || ""); if (!/^\d{17}$/.test(sid)) bad("Неверный SteamID");
  const p = STATS.player(sid); if (!p) bad("Игрок ещё не играл на сервере", 404);
  return { player: withSkill(p) };
});
// надетые скины другого игрока (вкладка «Скины» в его профиле): только то, что он сам надел на сайте
get("/api/loadout", ctx => {
  const sid = String(ctx.query.get("sid") || ""); if (!/^\d{17}$/.test(sid)) bad("Неверный SteamID");
  const u = db.prepare("SELECT id FROM users WHERE steamid=?").get(sid); if (!u) return { loadout: [] };
  return { loadout: db.prepare("SELECT l.team, i.w, i.s, i.wear, i.seed, i.st, i.stk FROM loadout l JOIN items i ON i.id=l.item_id WHERE l.user_id=? AND i.state='inv' ORDER BY l.team, l.slot").all(u.id)
    .map(r => ({ team: r.team, w: r.w, s: r.s, wear: r.wear, seed: r.seed, st: !!r.st, stk: stkOf(r) })) };
});
if (CFG.gameLogUnit && require.main === module) {
  const curRow = db.prepare("SELECT v FROM meta WHERE k='jcursor'").get();
  const saveCur = db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('jcursor',?)");
  JOURNAL.follow({ unit: CFG.gameLogUnit, bin: CFG.journalBin, cursor: curRow ? curRow.v : "", onCursor: c => saveCur.run(c),
    onLine: (msg, t, sys) => {
      if (sys) { if (/^(Stopped|Stopping|Started|Starting) |Main process exited|Failed with result/.test(msg)) STATS.serverStop(t); return; }
      // строка плагина TasherStyle: итог особого раунда
      if (msg.startsWith("TASHERFUN ")) { try { FUN.marker(msg.trim(), t, STATS.state.warm); } catch (e) { console.error("[fun]", e.message); } return; }
      if (msg.charCodeAt(0) !== 76 /* L */) return;
      const ev = GL.parseLine(msg), warm = STATS.state.warm; STATS.apply(ev);
      // ТК за игру (разминку не считаем)
      try {
        EARN.apply(ev, warm);
        QUESTS.apply(ev, warm);
        if (LEAGUES_ENABLED) SKILL.apply(ev, warm);
        PASS.apply(ev, warm);
        FUN.apply(ev, warm);
        if (ev && ev.e === "round" && !warm) {
          const inGame = [...STATS.state.team].filter(([sid, team]) => team && STATS.state.sess.has(sid));
          const winners = inGame.filter(([, team]) => team === ev.win).map(([sid]) => sid), losers = inGame.filter(([, team]) => team !== ev.win).map(([sid]) => sid);
          EARN.roundWin(winners, ev.t || t); QUESTS.roundWin(winners, ev.t || t); if (LEAGUES_ENABLED) SKILL.round(winners, losers); PASS.roundWin(winners, ev.t || t);
        }
      } catch (e) { console.error("[earn]", e.message); }
      // зашёл игрок — данные для !rank/!tk/!quests нужны ему сразу
      if (ev && (ev.e === "enter" || ev.e === "connect") && now() - t < 120e3) infoSoon();
      // забаненный зашёл — выгоняем (только по свежим строкам, не при перечитывании старого журнала)
      if (ev && ev.e !== "leave" && now() - t < 120e3) for (const p of [ev.a, ev.v]) if (p && p.sid) CTL.enforce(p.sid, p.uid);
    } });
}

// итоги месяца (игроки и кланы): проверяем при запуске и каждые 10 минут (сработает один раз после конца месяца)
const runAllAwards = () => { try { CTL.runAwards(); } catch (e) { console.error("[awards]", e); } try { if (CLANS.runAwards()) styleSync(); } catch (e) { console.error("[clan awards]", e); } };
if (CFG.gameLogUnit && require.main === module) { setTimeout(runAllAwards, 15e3).unref(); setInterval(runAllAwards, 600e3).unref(); }

// ---------- ТК за игру ----------
const statusTier = (() => { let m = new Map(), at = 0; return sid => { if (now() - at > 30e3) { m = new Map(CTL.statuses().map(s => [s.sid, s.t])); at = now(); } return m.get(sid) || null; }; })();
const EVENTS = makeEvents({ db });
// ---------- боевой пропуск ----------
const PASS = makePass({ db, tx: fn => tx(db, fn), addMoney, giveItem, rollCase: G.rollCase, caseByK: k => G.CASE_BY_K.get(k), cosById: id => COSM.get(id),
  addGrant: (...a) => CTL.addGrant(...a), onGrant: () => { vipSync(); styleSync(); }, eventMult: t => EVENTS.mult("xp", t) });
// новый сезон пропуска — мягкий сброс лиг (один раз; первый сезон только запоминаем)
function seasonCheck() {
  const ss = PASS.season(); if (!ss) return;
  const m = db.prepare("SELECT v FROM meta WHERE k='season'").get();
  if (m && m.v === ss.id) return;
  if (m && LEAGUES_ENABLED) { SKILL.softReset(0.5); console.log(`[season] начался ${ss.n}: лиги сброшены наполовину`); }
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('season',?)").run(ss.id);
}
try { seasonCheck(); } catch (e) { console.error("[season]", e.message); }
if (require.main === module) setInterval(() => { try { seasonCheck(); } catch (e) {} }, 3600e3).unref();
// ---------- игровые бонусы: первая кровь, эйс, особые раунды ----------
// сообщения в чат игры — по очереди, чтобы не перепутался порядок
const gameSay = (() => { let q = Promise.resolve(); return m => {
  if (!CFG.gameServers.length || !CFG.gameRcon || require.main !== module) return;
  q = q.then(() => A2S.rconExec(CFG.gameServers[0], CFG.gameRcon, "say " + require("./lib/control").consoleText(m, 180), 3000)).catch(() => {});
}; })();
const FUN = makeFun({ db, tx: fn => tx(db, fn), addMoney, addXp: (sid, v, t) => PASS.addXp(sid, v, t), eventMult: t => EVENTS.mult("tk", t),
  inGame: () => [...STATS.state.team].filter(([sid, team]) => team && STATS.state.sess.has(sid)), say: gameSay });
get("/api/fun", () => FUN.info());
const passCall = f => { try { return f(); } catch (e) { if (!(e instanceof HttpError) && Number.isInteger(e.code)) bad(e.message, e.code); throw e; } };
get("/api/pass", ctx => PASS.state(ctx.user ? ctx.user.steamid : null));
post("/api/pass/buy", ctx => { const u = needUser(ctx); rateLimit("pass:" + u.id, 10, 60e3); const r = passCall(() => PASS.buyPremium(u)); infoSoon(); return { ...r, pass: PASS.state(u.steamid), purchases: userPurchases(u.id) }; });
post("/api/pass/claim", ctx => {
  const u = needUser(ctx); rateLimit("pass:" + u.id, 30, 60e3);
  const r = passCall(() => PASS.claim(u, ctx.body || {}));
  const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  infoSoon();
  return { ...r, pass: PASS.state(u.steamid), user: pubUser(fresh), items: userItems(u.id), cos: userCos(fresh), freeCases: freeCases(u.id), statuses: r.status ? CTL.statuses() : undefined };
});
get("/api/events", () => EVENTS.state());
get("/api/admin/events", ctx => { needAdmin(ctx); return { events: EVENTS.list(), kinds: Object.entries(EVENTS.KINDS).map(([k, v]) => ({ k, n: v.n })) }; });
post("/api/admin/events", ctx => {
  const a = needAdmin(ctx); const b = ctx.body || {};
  const r = b.act === "create" ? EVENTS.create(a, b) : b.act === "toggle" ? EVENTS.toggle(b.id, !!b.on) : b.act === "remove" ? EVENTS.remove(b.id) : { error: "Неизвестное действие" };
  if (r.error) bad(r.error, r.code || 400);
  console.log(`[admin] ${a.name}(${a.id}) события: ${b.act} ${b.id || b.title || ""}`);
  setImmediate(eventTick);
  return { ...r, state: EVENTS.state() };
});
// начало и конец события — объявление в чате игры; пока идёт — напоминание раз в 30 минут
// то, что уже идёт при запуске сайта, не объявляем как «началось»; события, добавленные админом позже, — объявляем
let evPrev = (() => { try { return new Map(EVENTS.active().map(a => [a.id, a])); } catch (e) { return new Map(); } })(), evRemind = 0;
const evUntil = t => new Date(t + 3 * 3600e3).toISOString().slice(11, 16);
async function eventTick() {
  let act; try { act = EVENTS.active(); } catch (e) { return; }
  const ids = new Map(act.map(a => [a.id, a]));
  const say = [];
  for (const [id, a] of ids) if (!evPrev.has(id)) say.push(`[TASHER] Началось событие ${a.title}: ${a.what} до ${evUntil(a.to)} МСК`);
  for (const [id, a] of evPrev) if (!ids.has(id)) say.push(`[TASHER] Событие ${a.title} закончилось. Следующие — на tashercs.ru`);
  if (!say.length && ids.size && now() - evRemind > 30 * 60e3) say.push(...[...ids.values()].map(a => `[TASHER] Идёт событие ${a.title}: ${a.what} до ${evUntil(a.to)} МСК`));
  evPrev = ids;
  if (!say.length || !CFG.gameServers.length || !CFG.gameRcon) return;
  evRemind = now();
  for (const m of say) { try { await A2S.rconExec(CFG.gameServers[0], CFG.gameRcon, "say " + require("./lib/control").consoleText(m, 180), 3000); } catch (e) {} }
}
if (require.main === module) { setTimeout(eventTick, 3000).unref(); setInterval(eventTick, 30e3).unref(); }
const EARN = makeEarn({ db, tx: fn => tx(db, fn), addMoney, statusOf: statusTier, eventMult: t => EVENTS.mult("tk", t), boostMult: (sid, t) => PASS.boostMult(sid, "tk2", t) });
if (CFG.gameLogUnit && require.main === module) {
  // минута в игре: всем, кто сейчас на сервере (если сервер живой — журнал писался за последние 3 минуты)
  setInterval(() => { try { if (now() - STATS.state.lastT < 180e3) { const on = [...STATS.state.sess.keys()]; EARN.minute(on, now()); QUESTS.minute(on, now()); PASS.minute(on, now()); } } catch (e) { console.error("[earn]", e.message); } }, 60e3).unref();
  setInterval(() => { try { EARN.flush(); } catch (e) { console.error("[earn]", e.message); } }, 30e3).unref();
}

// ---------- ежедневные задания ----------
const QUESTS = makeQuests({ db, tx: fn => tx(db, fn), addMoney, eventMult: t => EVENTS.mult("quest", t), onDone: done => {
  for (const d of done) { console.log(`[quests] ${d.sid} выполнил${d.week ? " задание недели" : ""} «${d.q.n}» +${d.reward} ТК`); try { PASS.quest(d.sid, d.q.id === "all" ? "all" : d.q.lv); } catch (e) { console.error("[pass]", e.message); } }
  infoSoon(); // плагин сразу напишет игроку «Задание выполнено»
} });
get("/api/quests", ctx => ({ quests: QUESTS.state(ctx.user ? ctx.user.steamid : null) }));
// ---------- достижения: разовая награда ТК за каждое выполненное ----------
const ACH = makeAchievements({ db, tx: fn => tx(db, fn), addMoney, PTS: GL.PTS });
// при запуске — проверить всех (в том числе выплатить за уже выполненное), потом раз в минуту — тех, кто играет
setTimeout(() => { try { ACH.checkAll(); } catch (e) { console.error("[ach]", e.message); } }, 20e3).unref();
setInterval(() => { try { for (const sid of STATS.state.sess.keys()) ACH.check(sid); } catch (e) { console.error("[ach]", e.message); } }, 60e3).unref();

// ---------- данные для команд в игре (!rank, !top, !tk, !quests) и приветствия статусов ----------
const ruPlural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
// лига для команды !rank: название и строка «до следующей лиги» или «калибровка»
function leagueFor(sid) {
  if (!LEAGUES_ENABLED) return { league: "", sr: 0, leagueInfo: "" };
  const k = SKILL.info(sid);
  if (k.lg == null) return { league: "", sr: k.sr, leagueInfo: `калибровка: ещё ${k.left} ${ruPlural(k.left, "событие", "события", "событий")} (убийства и смерти)` };
  return { league: SKILLM.LEAGUES[k.lg].n, sr: k.sr, leagueInfo: k.next ? `до лиги ${k.next.n}: ${k.next.need} очк.` : "высшая лига" };
}
function infoRows() {
  const st = new Map(CTL.statuses().map(s => [s.sid, s.t]));
  const top = STATS.top(GL.month(now()), 2000), place = new Map(top.map((p, i) => [p.sid, i + 1]));
  const monthRating = new Map(top.map(p => [p.sid, p.pts]));
  const sids = new Set([...STATS.state.uid.keys(), ...st.keys()]);
  const user = db.prepare("SELECT tk, name FROM users WHERE steamid=?"), pend = db.prepare("SELECT tk FROM earn_pending WHERE sid=?");
  const players = [...sids].map(sid => {
    const p = STATS.player(sid) || {}, u = user.get(sid), on = STATS.state.uid.get(sid);
    return { sid, n: (on && on.n) || p.n || (u && u.name) || "", tier: st.get(sid) || "", place: place.get(sid) || 0, pts: monthRating.get(sid) || 0, k: p.mk || 0, d: p.md || 0, hs: p.mhs || 0,
      tk: u ? u.tk : null, pending: Math.floor((pend.get(sid) || {}).tk || 0), earn: EARN.today(sid), quests: QUESTS.state(sid), ...leagueFor(sid), pass: PASS.brief(sid) };
  });
  return { players, top: top.slice(0, 10).map(p => ({ sid: p.sid, n: p.n, pts: p.pts, k: p.mk, d: p.md })), sanctions: CTL.activeSanctions() };
}
const infoSync = INFO.makeInfoSync({ cnf: CFG.wpCnf, bin: CFG.mysqlBin, collect: infoRows,
  reload: () => CFG.gameServers.length && CFG.gameRcon ? A2S.rconExec(CFG.gameServers[0], CFG.gameRcon, "css_tasher_style_reload", 3000) : null });
let infoT = null;
// fast — мут или гег: применить в игре почти сразу
function infoSoon(fast) {
  if (!CFG.wpCnf) return;
  if (fast) { clearTimeout(infoT); infoT = null; setImmediate(() => infoSync(true)); return; }
  if (infoT) return; infoT = setTimeout(() => { infoT = null; infoSync(); }, 3000); infoT.unref();
}
if (CFG.wpCnf && require.main === module) { setTimeout(() => infoSync(), 5000).unref(); setInterval(() => infoSync(), 30e3).unref(); }

// ---------- Фортуна ----------
const WHEEL = makeWheel({ db, tx: fn => tx(db, fn), addMoney, addGrant: (...a) => CTL.addGrant(...a), statusOf: sid => (CTL.statuses().find(s => s.sid === sid) || {}).t || null });
post("/api/wheel/spin", ctx => {
  const u = needUser(ctx); rateLimit("wheel:" + u.id, 5, 10e3);
  let r; try { r = WHEEL.spin(u); } catch (e) { if (e.code) bad(e.message, e.code); throw e; }
  if (r.tier) { vipSync(); styleSync(); }
  return { ...r, wheel: WHEEL.state(u), statuses: r.tier ? CTL.statuses() : undefined };
});

// ---------- джекпот ----------
const AGENTS = new Set(G.W.filter(w => w.c === "agent").map(w => w.n));
const JP = makeJackpot({ db, tx: fn => tx(db, fn), takeItems, itemValue: r => G.itemValue(r), isAgent: w => AGENTS.has(w), pubItem, onLock: u => syncGame(u) });
if (require.main === module) setInterval(() => { try { JP.tick(); } catch (e) { console.error("[jackpot]", e); } }, 500).unref();
get("/api/jackpot", ctx => JP.view(ctx.user));
post("/api/jackpot/bet", ctx => {
  const u = needUser(ctx); rateLimit("jp:" + u.id, 10, 10e3);
  let r; try { r = JP.bet(u, ctx.body.ids); } catch (e) { if (e.code) bad(e.message, e.code); throw e; }
  return { ...r, view: JP.view(u), items: userItems(u.id) };
});

// ---------- кланы ----------
const CLANS = makeClans({ db, tx: fn => tx(db, fn), addMoney, month: GL.month, prevMonth: require("./lib/control").prevMonth });
// картинки клана хранятся в базе как data:image/...; сайту отдаём ссылками, чтобы список кланов был лёгким
const clanImgUrl = (c, k) => c[k] ? `/api/clans/img?id=${c.id}&k=${k}&v=${crypto.createHash("sha1").update(c[k]).digest("hex").slice(0, 10)}` : null;
function clansOut(u) {
  const L = CLANS.list(u);
  for (const c of L.clans) { c.ava = c.ava ? clanImgUrl(c, "ava") : null; c.cover = c.cover ? clanImgUrl(c, "cover") : null; }
  return L;
}
function clanImg(req, res, url) {
  const id = +url.searchParams.get("id"), k = url.searchParams.get("k");
  const c = (k === "ava" || k === "cover") && Number.isInteger(id) ? db.prepare(`SELECT ${k} v FROM clans WHERE id=?`).get(id) : null;
  const m = c && c.v && /^data:(image\/(?:webp|jpeg|png));base64,(.+)$/.exec(c.v);
  if (!m) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": m[1], "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
  return res.end(Buffer.from(m[2], "base64"));
}
const clanAct = fn => ctx => {
  const u = needUser(ctx); rateLimit("clan:" + u.id, 30, 60e3);
  try { fn(u, ctx.body); } catch (e) { if (e.code) bad(e.message, e.code); throw e; }
  styleSync();
  return { ...clansOut(u), me: pubUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)) };
};
get("/api/clans", ctx => clansOut(ctx.user));
post("/api/clans/create", clanAct((u, b) => CLANS.create(u, b)));
post("/api/clans/apply", clanAct((u, b) => CLANS.apply(u, +b.id)));
post("/api/clans/cancel", clanAct((u, b) => CLANS.cancelApp(u, +b.id)));
post("/api/clans/decide", clanAct((u, b) => CLANS.decide(u, +b.id, !!b.accept)));
post("/api/clans/leave", clanAct(u => CLANS.leave(u)));
post("/api/clans/kick", clanAct((u, b) => CLANS.kick(u, +b.user)));
post("/api/clans/transfer", clanAct((u, b) => CLANS.transfer(u, +b.user)));
post("/api/clans/edit", clanAct((u, b) => CLANS.edit(u, b)));
post("/api/clans/deposit", clanAct((u, b) => CLANS.deposit(u, +b.v)));
post("/api/clans/upgrade", clanAct((u, b) => CLANS.upgrade(u, b)));

// ---------- стиль в игре (плагин TASHER Style) ----------
function styleRows() {
  const st = new Map(CTL.statuses().map(s => [s.sid, s.t])), rows = new Map();
  const row = sid => { let r = rows.get(sid); if (!r) rows.set(sid, r = { sid, tier: st.get(sid) || null, clanTag: "", clanColor: "", nick: "", tag: "", smokeHex: "", killFx: "", killSnd: "", trailHex: "", tracerHex: "", mvpSnd: "", model: "" }); return r; };
  for (const sid of st.keys()) row(sid);
  // UPD: в Tab только название привилегии (лиг и чисел нет); очки месяца идут отдельно через tasher_player.pts (lib/gameinfo.js).
  for (const c of db.prepare("SELECT u.steamid sid, c.tag, c.color FROM clan_members m JOIN clans c ON c.id=m.clan_id JOIN users u ON u.id=m.user_id").all()) { const r = row(c.sid); r.clanTag = c.tag; r.clanColor = c.color; }
  for (const u of db.prepare("SELECT steamid, cos_eq, cos_tag FROM users WHERE cos_eq<>'{}' OR cos_tag<>''").all()) {
    let eq = {}; try { eq = JSON.parse(u.cos_eq || "{}"); } catch (e) {}
    const it = cat => { const x = COSM.get(eq[cat]); return x && x.cat === cat ? x : null; };
    const nick = it("nick"), smoke = it("smoke"), kill = it("kill"), snd = it("snd"), trail = it("trail"), tracer = it("tracer"), mvp = it("mvp"), model = it("model"), tag = eq.tag && u.cos_tag ? u.cos_tag : "";
    if (!nick && !smoke && !kill && !snd && !trail && !tracer && !mvp && !model && !tag) continue;
    const r = row(u.steamid);
    if (nick) r.nick = nick.id; if (smoke) r.smokeHex = smoke.v; if (tag) r.tag = tag;
    if (kill) r.killFx = kill.v; if (snd) r.killSnd = snd.id.slice(3); if (trail) r.trailHex = trail.v; if (tracer) r.tracerHex = tracer.v; if (mvp) r.mvpSnd = mvp.id.slice(3); if (model) r.model = model.v;
  }
  return [...rows.values()];
}
styleSync = STYLE.makeStyleSync({ cnf: CFG.wpCnf, bin: CFG.mysqlBin, collect: styleRows,
  reload: () => CFG.gameServers.length && CFG.gameRcon ? A2S.rconExec(CFG.gameServers[0], CFG.gameRcon, "css_tasher_style_reload", 3000) : null });
if (CFG.wpCnf && require.main === module) { setTimeout(() => styleSync(), 4000).unref(); setInterval(() => styleSync(), 60e3).unref(); }

// ---------- магазин: статусы и оформление профиля за рубли с баланса ----------
const TIER_P = { VIP: 99, PREMIUM: 199, ELITE: 349, LEGEND: 549, TITAN: 899, KING: 1499 };
const PERIODS = { 30: 0, 90: 0.1, 180: 0.2 };
const tierPrice = (tier, days) => Math.round(TIER_P[tier] * days / 30 * (1 - PERIODS[days]) / 10) * 10 - 1;
// предметы, убранные из магазина: один раз возвращаем деньги за купленные (₽ на баланс), за полученные из пропуска — 500 ТК
function retireItems(key, ids, why) {
  if (db.prepare("SELECT 1 FROM meta WHERE k=?").get(key)) return;
  tx(db, () => {
    const own = db.prepare(`SELECT user_id, item_id FROM cos_own WHERE ${ids.like ? "item_id LIKE ? ESCAPE '\\'" : `item_id IN (${ids.list.map(() => "?").join(",")})`}`).all(...(ids.like ? [ids.like] : ids.list));
    for (const r of own) {
      const paid = db.prepare("SELECT -delta p FROM ledger WHERE user_id=? AND kind='shop' AND cur='rub' AND ref=? ORDER BY id DESC LIMIT 1").get(r.user_id, "cos:" + r.item_id);
      if (paid && paid.p > 0) addMoney(r.user_id, "rub", paid.p, "refund", "cos:" + r.item_id, { what: "Возврат: " + why });
      else addMoney(r.user_id, "tk", 500, "refund", "cos:" + r.item_id, { what: "Компенсация: " + why });
      db.prepare("DELETE FROM cos_own WHERE user_id=? AND item_id=?").run(r.user_id, r.item_id);
    }
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES(?, '1')").run(key);
  });
}
retireItems("badge_refund", { like: "bd\\_%" }, "значки убраны с сайта"); // 24.11.2026
retireItems("white_fx_refund", { list: ["tr_0", "tc_0"] }, "белые трассеры и след гранат теперь у всех бесплатно"); // 25.11.2026
retireItems("mvp_refund", { like: "mv\\_%" }, "звуки MVP убраны с сервера"); // 25.11.2026
retireItems("trail_cleanup_refund", { list: ["tr_3", "tr_7", "sm_9"] }, "оранжевый и золотой трейлы и графитовый дым убраны из магазина"); // 25.11.2026
// 25.11.2026: сувенирные предметы без наклеек турнира получают их (и сразу обновляются в игре, если надеты)
(function fixSouvenirStickers() {
  if (db.prepare("SELECT 1 FROM meta WHERE k='sv_stk_fix'").get()) return;
  const touched = new Set();
  tx(db, () => {
    for (const r of db.prepare("SELECT id, user_id FROM items WHERE sv=1 AND (stk IS NULL OR stk='')").all()) {
      const stk = souvenirStk(); if (!stk) return; // списка наклеек нет — попробуем при следующем запуске
      db.prepare("UPDATE items SET stk=? WHERE id=?").run(JSON.stringify(stk), r.id); touched.add(r.user_id);
    }
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('sv_stk_fix','1')").run();
  });
  setTimeout(() => { for (const uid of touched) { const u = db.prepare("SELECT * FROM users WHERE id=?").get(uid); if (u) try { syncGame(u); } catch (e) {} } }, 3000);
})();
// 25.11.2026: у предметов Blue Gem / Fade 100% сид был случайным — в игре узор не совпадал. Ставим настоящий сид паттерна.
(function fixPatternSeeds() {
  if (db.prepare("SELECT 1 FROM meta WHERE k='sp_seed_fix2'").get()) return; // 2: сиды Blue Gem уточнены (сид №1, синий с обеих сторон)
  const touched = new Set();
  tx(db, () => {
    for (const r of db.prepare("SELECT id, user_id, w, sp, seed FROM items WHERE sp IN ('bg','f100')").all()) {
      const l = G.SP_SEEDS[r.sp] && G.SP_SEEDS[r.sp][r.w];
      if (!l || l.includes(r.seed)) continue;
      db.prepare("UPDATE items SET seed=? WHERE id=?").run(l[0], r.id);
      touched.add(r.user_id);
    }
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('sp_seed_fix2','1')").run();
  });
  setTimeout(() => { for (const uid of touched) { const u = db.prepare("SELECT * FROM users WHERE id=?").get(uid); if (u) try { syncGame(u); } catch (e) {} } }, 3000);
})();
const COSM = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "data", "cosmetics.json"), "utf8")).map(x => [x.id, x]));
const COS_EQ_CATS = ["frame", "bg", "rbg", "rrow", "nick", "smoke", "tag", "kill", "snd", "trail", "tracer", "model"]; // что надевается (свой тег покупается отдельно — /api/cos/tag)
function userCos(u) { let eq = {}; try { eq = JSON.parse(u.cos_eq || "{}"); } catch (e) {} delete eq.badge; return { own: db.prepare("SELECT item_id FROM cos_own WHERE user_id=? ORDER BY created_at").all(u.id).map(r => r.item_id), eq, tag: u.cos_tag || "" }; }
function userPurchases(uid) {
  return db.prepare("SELECT delta, meta, created_at FROM ledger WHERE user_id=? AND kind='shop' ORDER BY id DESC LIMIT 50").all(uid)
    .map(r => { let m = {}; try { m = JSON.parse(r.meta || "{}"); } catch (e) {} return { t: r.created_at, what: String(m.what || "Покупка"), p: -r.delta }; });
}
post("/api/shop/tier", ctx => {
  const u = needUser(ctx); rateLimit("shop:" + u.id, 10, 60e3);
  const tier = Object.hasOwn(TIER_P, ctx.body.tier) ? ctx.body.tier : bad("Неизвестный статус");
  const days = Number(ctx.body.days); if (!Object.hasOwn(PERIODS, days)) bad("Срок: 30, 90 или 180 дней");
  let sid = u.steamid, gname = "";
  if (ctx.body.gift != null && String(ctx.body.gift).trim()) {
    const r = CTL.resolve(ctx.body.gift); if (r.error) bad(r.error);
    if (r.sid === u.steamid) bad("Это твой SteamID — выбери «Себе»");
    sid = r.sid; gname = r.name || "Игрок";
  }
  const price = tierPrice(tier, days);
  const what = `Статус ${tier} на ${days} дней` + (gname ? ` в подарок ${gname}` : "");
  const out = tx(db, () => {
    const balance = addMoney(u.id, "rub", -price, "shop", "tier:" + tier, { what, tier, days, sid });
    const g = CTL.addGrant(sid, tier, days, "shop", gname ? `подарок от ${u.name || "игрока"}` : "покупка", u.name || ("Player" + u.id));
    return { balance, until: g.until, extended: g.extended };
  });
  console.log(`[shop] ${u.name}(${u.id}) ${what} за ${price} ₽`);
  vipSync();
  return { ...out, price, what, statuses: CTL.statuses(), purchases: userPurchases(u.id) };
});
post("/api/shop/cos", ctx => {
  const u = needUser(ctx); rateLimit("cos:" + u.id, 30, 60e3);
  const out = (() => {
  const it = COSM.get(String(ctx.body.id || "")); if (!it || !COS_EQ_CATS.includes(it.cat) || it.cat === "tag") bad("Такого предмета нет");
  if (it.ex && !db.prepare("SELECT 1 FROM cos_own WHERE user_id=? AND item_id=?").get(u.id, it.id)) bad(`«${it.n}» не продаётся — это награда пропуска «${it.ex}», уровень ${it.lv}`);
  return tx(db, () => {
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
    let balance = fresh.rub;
    if (!db.prepare("SELECT 1 FROM cos_own WHERE user_id=? AND item_id=?").get(u.id, it.id)) {
      balance = addMoney(u.id, "rub", -it.p, "shop", "cos:" + it.id, { what: `Оформление: ${it.n}` });
      db.prepare("INSERT INTO cos_own(user_id,item_id,created_at) VALUES(?,?,?)").run(u.id, it.id, now());
    }
    const eq = userCos(fresh).eq; eq[it.cat] = it.id;
    db.prepare("UPDATE users SET cos_eq=? WHERE id=?").run(JSON.stringify(eq), u.id);
    return { balance, cos: userCos({ ...fresh, cos_eq: JSON.stringify(eq) }), purchases: userPurchases(u.id) };
  });
  })();
  styleSync(); return out;
});
// свой тег в чате: латиница и цифры, до 6 символов; каждая смена платная, снять — бесплатно
post("/api/cos/tag", ctx => {
  const u = needUser(ctx); rateLimit("cos:" + u.id, 30, 60e3);
  const it = COSM.get("tag"); if (!it) bad("Тег сейчас недоступен");
  const tag = String(ctx.body.tag == null ? "" : ctx.body.tag).toUpperCase().trim();
  const out = tx(db, () => {
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
    let eq = {}; try { eq = JSON.parse(fresh.cos_eq || "{}"); } catch (e) {}
    if (!tag) bad("Впиши тег");
    if (!/^[A-Z0-9]{1,6}$/.test(tag)) bad("Тег: латинские буквы и цифры, до 6 символов");
    if (tag === fresh.cos_tag) bad("Такой тег уже стоит");
    const balance = addMoney(u.id, "rub", -it.p, "shop", "cos:tag", { what: `Свой тег в чате [${tag}]` });
    db.prepare("INSERT OR IGNORE INTO cos_own(user_id,item_id,created_at) VALUES(?,?,?)").run(u.id, "tag", now());
    eq.tag = "tag";
    db.prepare("UPDATE users SET cos_tag=?, cos_eq=? WHERE id=?").run(tag, JSON.stringify(eq), u.id);
    return { balance };
  });
  styleSync();
  const u2 = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  return { ...out, cos: userCos(u2), purchases: userPurchases(u.id) };
});
post("/api/cos/eq", ctx => {
  const u = needUser(ctx);
  const cat = COS_EQ_CATS.includes(ctx.body.cat) ? ctx.body.cat : bad("Неверный раздел");
  const eq = userCos(u).eq;
  if (ctx.body.id == null) delete eq[cat];
  else {
    const it = COSM.get(String(ctx.body.id)); if (!it || it.cat !== cat) bad("Такого предмета нет");
    if (!db.prepare("SELECT 1 FROM cos_own WHERE user_id=? AND item_id=?").get(u.id, it.id)) bad("Сначала купи этот предмет", 409);
    eq[cat] = it.id;
  }
  db.prepare("UPDATE users SET cos_eq=? WHERE id=?").run(JSON.stringify(eq), u.id);
  styleSync();
  return { cos: userCos({ ...u, cos_eq: JSON.stringify(eq) }) };
});

// ---------- банлист, статусы, итоги месяца (публично) ----------
get("/api/bans", () => ({ bans: CTL.listBans() }));
get("/api/statuses", () => ({ statuses: CTL.statuses(), awards: CTL.listAwards() }));

// лента последних выпадений (для блока Live)
let DROPS_CACHE = { t: 0, v: null };
get("/api/drops", () => {
  if (DROPS_CACHE.v && now() - DROPS_CACHE.t < 2000) return DROPS_CACHE.v;
  const rows = db.prepare(`SELECT i.w,i.s,i.r,i.wear,i.st,i.sv,i.sp,i.src,i.src_ref,i.created_at,u.name,u.id uid FROM items i JOIN users u ON u.id=i.user_id
    WHERE i.src IN ('case','upgrade') ORDER BY i.created_at DESC LIMIT 30`).all();
  DROPS_CACHE = { t: now(), v: { drops: rows.map(r => ({ n: r.name || ("Player" + r.uid), w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, src: r.src, c: r.src === "case" ? r.src_ref : null, t: r.created_at })) } };
  return DROPS_CACHE.v;
});

// ---------- поддержка ----------
const TOPICS = ["ban", "pay", "bug", "admin", "other"];
const cleanText = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, "").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, max);
function ticketsOut(rows, withSid) {
  const q = db.prepare("SELECT staff, body, created_at FROM ticket_msgs WHERE ticket_id=? ORDER BY id");
  return rows.map(t => ({ id: t.id, uid: t.user_id, n: t.name || ("Player" + t.user_id), sid: withSid ? t.steamid : undefined, r: t.topic, subj: t.subj, st: t.state,
    msgs: q.all(t.id).map(m => ({ a: m.staff ? 1 : 0, t: m.body, d: new Date(m.created_at).toISOString() })) }));
}
get("/api/tickets", ctx => {
  const u = needUser(ctx); const all = ctx.query.get("all") === "1";
  if (all && u.role !== "owner") bad("Нет доступа", 403);
  const rows = all ? db.prepare("SELECT t.*, u.name, u.steamid FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 300").all()
    : db.prepare("SELECT t.*, u.name, u.steamid FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 50").all(u.id);
  return { tickets: ticketsOut(rows, all) };
});
post("/api/tickets", ctx => {
  const u = needUser(ctx);
  const topic = TOPICS.includes(ctx.body.r) ? ctx.body.r : bad("Выбери тему обращения");
  const subj = cleanText(ctx.body.subj, 100).replace(/\n/g, " "); if (subj.length < 3) bad("Коротко напиши, что случилось: хотя бы 3 символа");
  const text = cleanText(ctx.body.text, 2500); if (text.length < 10) bad("Опиши проблему подробнее: хотя бы 10 символов");
  rateLimit("tk:" + u.id, 3, 600e3);
  return tx(db, () => {
    const open = db.prepare("SELECT COUNT(*) c FROM tickets WHERE user_id=? AND state<>'closed'").get(u.id).c;
    if (open >= 5) bad("У тебя уже 5 открытых обращений. Дождись ответа или дополни одно из них", 409);
    const id = db.prepare("SELECT COALESCE(MAX(id),1000)+1 v FROM tickets").get().v, t = now();
    db.prepare("INSERT INTO tickets(id,user_id,topic,subj,state,created_at,updated_at) VALUES(?,?,?,?,'wait',?,?)").run(id, u.id, topic, subj, t, t);
    db.prepare("INSERT INTO ticket_msgs(ticket_id,user_id,staff,body,created_at) VALUES(?,?,0,?,?)").run(id, u.id, text, t);
    return { id };
  });
});
post("/api/tickets/reply", ctx => {
  const u = needUser(ctx); rateLimit("tkr:" + u.id, 10, 60e3);
  const text = cleanText(ctx.body.text, 1000); if (text.length < 2) bad("Напиши сообщение");
  const staff = ctx.body.staff === true;
  if (staff && u.role !== "owner") bad("Нет доступа", 403);
  return tx(db, () => {
    const t = db.prepare("SELECT * FROM tickets WHERE id=?").get(Number.isInteger(ctx.body.id) ? ctx.body.id : -1);
    if (!t || (!staff && t.user_id !== u.id)) bad("Обращение не найдено", 404);
    if (t.state === "closed") bad("Тикет закрыт", 409);
    const n = db.prepare("SELECT COUNT(*) c FROM ticket_msgs WHERE ticket_id=?").get(t.id).c; if (n >= 200) bad("В этом обращении слишком много сообщений, создай новое", 409);
    db.prepare("INSERT INTO ticket_msgs(ticket_id,user_id,staff,body,created_at) VALUES(?,?,?,?,?)").run(t.id, u.id, staff ? 1 : 0, text, now());
    db.prepare("UPDATE tickets SET state=?, updated_at=? WHERE id=?").run(staff ? "answered" : "wait", now(), t.id);
    return { ok: true };
  });
});
post("/api/tickets/state", ctx => {
  const u = needUser(ctx); if (u.role !== "owner") bad("Нет доступа", 403);
  const state = ["closed", "wait"].includes(ctx.body.state) ? ctx.body.state : bad("Состояние: closed или wait");
  const r = db.prepare("UPDATE tickets SET state=?, updated_at=? WHERE id=?").run(state, now(), Number.isInteger(ctx.body.id) ? ctx.body.id : -1);
  if (!r.changes) bad("Обращение не найдено", 404);
  return { ok: true };
});

// ---------- админка ----------
get("/api/admin/users", ctx => {
  needAdmin(ctx); const q = String(ctx.query.get("q") || "").trim().slice(0, 64);
  const rows = q ? db.prepare("SELECT * FROM users WHERE name LIKE ? OR steamid=? OR id=? ORDER BY last_login DESC LIMIT 50").all("%" + q.replace(/[%_]/g, "") + "%", q, +q || -1)
    : db.prepare("SELECT * FROM users ORDER BY last_login DESC LIMIT 50").all();
  return { users: rows.map(u => ({ ...pubUser(u), banned: !!u.banned, last: u.last_login })) };
});
post("/api/admin/balance", ctx => {
  const a = needAdmin(ctx);
  const cur = ["rub", "tk", "xp"].includes(ctx.body.cur) ? ctx.body.cur : bad("Валюта: tk, rub или xp");
  const delta = Math.trunc(+ctx.body.delta); if (!delta || Math.abs(delta) > 1e8) bad("Неверная сумма");
  const reason = String(ctx.body.reason || "").trim().slice(0, 200); if (!reason) bad("Укажи причину");
  const target = db.prepare("SELECT * FROM users WHERE id=? OR steamid=?").get(+ctx.body.user || -1, String(ctx.body.user || ""));
  if (!target) bad("Игрок не найден", 404);
  if (cur === "xp") { // опыт боевого пропуска (2000 = 1 уровень)
    const r = tx(db, () => { const r = PASS.adminXp(target.steamid, delta);
      db.prepare("INSERT INTO ledger(user_id,cur,delta,after,kind,ref,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(target.id, "xp", delta, r.xp, "admin", "by:" + a.id, JSON.stringify({ by: a.id, byName: a.name || ("Player" + a.id), reason }), now()); return r; });
    console.log(`[admin] ${a.name}(${a.id}) xp ${delta > 0 ? "+" : ""}${delta} -> ${target.name}(${target.id}): ${reason}`);
    return { user: pubUser(target), pass: r };
  }
  const after = tx(db, () => addMoney(target.id, cur, delta, "admin", "by:" + a.id, { by: a.id, byName: a.name || ("Player" + a.id), reason }));
  console.log(`[admin] ${a.name}(${a.id}) ${cur} ${delta > 0 ? "+" : ""}${delta} -> ${target.name}(${target.id}): ${reason}`);
  return { user: pubUser({ ...target, [cur]: after }) };
});
post("/api/admin/role", ctx => {
  const a = needAdmin(ctx); if (a.role !== "owner") bad("Роли меняет только владелец", 403);
  const role = ["player", "admin"].includes(ctx.body.role) ? ctx.body.role : bad("Роль: player или admin");
  const target = db.prepare("SELECT * FROM users WHERE id=?").get(+ctx.body.user || -1); if (!target) bad("Игрок не найден", 404);
  if (target.role === "owner") bad("Нельзя менять роль владельца");
  db.prepare("UPDATE users SET role=? WHERE id=?").run(role, target.id);
  return { ok: true };
});
const ctlOut = r => { if (r && r.error) bad(r.error, r.code || 400); return r; };
post("/api/admin/ban", async ctx => { const a = needAdmin(ctx); rateLimit("ban:" + a.id, 20, 60e3); return ctlOut(await CTL.ban(a, ctx.body)); });
post("/api/admin/unban", ctx => { const a = needAdmin(ctx); return ctlOut(CTL.unban(a, ctx.body.id)); });
post("/api/admin/grant", ctx => { const a = needAdmin(ctx); return ctlOut(CTL.grant(a, ctx.body)); });
post("/api/admin/revoke", ctx => { const a = needAdmin(ctx); return ctlOut(CTL.revoke(a, String(ctx.body.sid || ""))); });
const rconOk = () => { if (!CFG.gameServers.length || !CFG.gameRcon) bad("Управление сервером не настроено (нет RCON)", 503); };
get("/api/admin/server", async ctx => {
  needAdmin(ctx); rconOk();
  try { return { ...(await CTL.serverInfo()), server: (GS || [])[0] || null }; } catch (e) { bad("Сервер не отвечает: " + e.message, 502); }
});
post("/api/admin/server", async ctx => {
  const a = needAdmin(ctx); rconOk(); rateLimit("srv:" + a.id, 20, 60e3);
  let r; try { r = await CTL.serverAct(a, ctx.body); } catch (e) { bad("Сервер не отвечает: " + e.message, 502); }
  return ctlOut(r);
});
get("/api/admin/ledger", ctx => {
  needAdmin(ctx); const uid = +ctx.query.get("user") || 0;
  const rows = uid ? db.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100").all(uid) : db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT 100").all();
  return { ledger: rows };
});
get("/api/admin/stats", ctx => {
  needAdmin(ctx); const day = now() - 864e5;
  const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0] || 0;
  return {
    users: one("SELECT COUNT(*) FROM users"), users24: one("SELECT COUNT(*) FROM users WHERE created_at>?", day),
    opens24: one("SELECT COALESCE(SUM(n),0) FROM case_opens WHERE created_at>?", day),
    spent24: one("SELECT COALESCE(SUM(price),0) FROM case_opens WHERE created_at>?", day),
    value24: one("SELECT COALESCE(SUM(value),0) FROM case_opens WHERE created_at>?", day),
    tkTotal: one("SELECT COALESCE(SUM(tk),0) FROM users"),
  };
});

// ---------- вход ----------
const safeRet = r => (typeof r === "string" && /^\/(?!\/)[\w\-./#?=&%]*$/.test(r) && r.length < 200) ? r : "/";
async function loginUser(req, res, steamid, ret) {
  const t = now();
  let u = db.prepare("SELECT * FROM users WHERE steamid=?").get(steamid);
  if (u && u.banned) return send(res, 403, "Аккаунт заблокирован");
  const prof = await steam.profile(CFG.steamKey, steamid);
  let banned = false;
  tx(db, () => {
    u = db.prepare("SELECT * FROM users WHERE steamid=?").get(steamid);
    if (u && u.banned) { banned = true; return; }
    if (!u) {
      db.prepare("INSERT INTO users(steamid,name,avatar,role,created_at,last_login) VALUES(?,?,?,?,?,?)").run(steamid, prof ? prof.name : "", prof ? prof.avatar : "", CFG.owners.has(steamid) ? "owner" : "player", t, t);
      u = db.prepare("SELECT * FROM users WHERE steamid=?").get(steamid);
      if (CFG.startTk) addMoney(u.id, "tk", CFG.startTk, "welcome");
      // приз рейтинга, выигранный до регистрации на сайте
      const cp = db.prepare("SELECT rub, note FROM cash_pending WHERE sid=? AND rub>0").get(steamid);
      if (cp) { addMoney(u.id, "rub", cp.rub, "award", "rating", { what: cp.note }); db.prepare("DELETE FROM cash_pending WHERE sid=?").run(steamid); }
    } else {
      db.prepare("UPDATE users SET last_login=?, name=COALESCE(?,name), avatar=COALESCE(?,avatar), role=CASE WHEN ? THEN 'owner' ELSE role END WHERE id=?")
        .run(t, prof ? prof.name : null, prof ? prof.avatar : null, CFG.owners.has(steamid) ? 1 : 0, u.id);
    }
  });
  if (banned) return send(res, 403, "Аккаунт заблокирован");
  syncGame(u); // при входе обновляем скины в игре (на случай, если база скинов была очищена)
  res.writeHead(302, { location: safeRet(ret), "set-cookie": startSession(res, req, u.id), "cache-control": "no-store" }); res.end();
}
async function authRoutes(req, res, url) {
  if (url.pathname === "/auth/steam") {
    res.writeHead(302, { location: steam.loginUrl(CFG.site, safeRet(url.searchParams.get("ret") || "/")), "cache-control": "no-store" }); return res.end(), true;
  }
  if (url.pathname === "/auth/steam/return") {
    rateLimit("login:" + clientIp(req), 20, 60e3);
    let sid = null; try { sid = await steam.verify(CFG.site, url.searchParams); } catch (e) { console.error("steam verify", e.message); }
    if (!sid) { send(res, 400, "Не удалось подтвердить вход через Steam. Попробуй ещё раз."); return true; }
    await loginUser(req, res, sid, url.searchParams.get("ret")); return true;
  }
  if (url.pathname === "/auth/dev" && CFG.devLogin) {
    const sid = String(url.searchParams.get("steamid") || "76561190000000001"); if (!/^\d{17}$/.test(sid)) { send(res, 400, "bad"); return true; }
    await loginUser(req, res, sid, url.searchParams.get("ret")); return true;
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const tok = cookies(req)[SID]; if (tok) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(tok));
    send(res, 200, { ok: true }, { "set-cookie": `${SID}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? "; Secure" : ""}` }); return true;
  }
  return false;
}

// ---------- статика сайта ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
const DENY = /^\/(server|tools|\.git|\.github|node_modules)(\/|$)|\/\.[^/]/;
// несуществующий адрес: людям показываем страницу 404 (она же перенаправляет /shop на /#shop), программам — короткий текст
function notFound(req, res) {
  if (!String(req.headers.accept || "").includes("text/html")) return send(res, 404, "Not found");
  fs.readFile(path.join(CFG.staticDir, "404.html"), (e, buf) => {
    if (e) return send(res, 404, "Not found");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-length": buf.length }); res.end(req.method === "HEAD" ? undefined : buf);
  });
}
function serveStatic(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, "bad path"); }
  if (DENY.test(p) || p.includes("\0")) return send(res, 404, "Not found");
  if (p.endsWith("/")) p += "index.html";
  if (p === "/index.html") return serveIndex(req, res);
  const file = path.join(CFG.staticDir, p);
  if (!file.startsWith(CFG.staticDir + path.sep)) return send(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    const ext = path.extname(file).toLowerCase();
    const longCache = url.search.includes("v=") || p.startsWith("/img/sk/");
    const head = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : longCache ? "public, max-age=31536000, immutable" : "public, max-age=3600", "last-modified": st.mtime.toUTCString() };
    const since = Date.parse(req.headers["if-modified-since"] || "");
    if (since && Math.floor(st.mtimeMs / 1000) * 1000 <= since) { res.writeHead(304, head); return res.end(); }
    res.writeHead(200, { ...head, "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
}

// главная страница: сервер вписывает в неё данные вошедшего игрока, чтобы сайт сразу открылся в нужном состоянии
let INDEX = { mtime: 0, a: "", b: "" };
function serveIndex(req, res) {
  const file = path.join(CFG.staticDir, "index.html");
  let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, "Not found"); }
  if (st.mtimeMs !== INDEX.mtime) {
    const html = fs.readFileSync(file, "utf8"); const i = html.indexOf("<head>") + 6;
    INDEX = { mtime: st.mtimeMs, a: html.slice(0, i), b: html.slice(i), tag: sha(html).slice(0, 16) };
  }
  const u = sessionUser(req);
  const data = u ? { user: pubUser(u), items: userItems(u.id), loadout: userLoadout(u.id), cos: userCos(u), purchases: userPurchases(u.id), freeCases: freeCases(u.id), wheel: WHEEL.state(u), earn: EARN.today(u.steamid), quests: QUESTS.state(u.steamid), achPaid: (ACH.check(u.steamid), ACH.paid(u.steamid)), achProg: ACH.progress(u.steamid), pass: PASS.state(u.steamid) } : { user: null, quests: QUESTS.state(null), pass: PASS.state(null) };
  // джекпот без отметки времени сервера — иначе страница никогда не отдавалась бы из кэша (время сверит первый опрос)
  data.clans = clansOut(u); { const ev = EVENTS.state(); delete ev.now; data.events = ev; } { const v = JP.view(u); delete v.now; data.jackpot = v; }
  if (GS) data.servers = GS; else if (CFG.gameServers.length) data.servers = []; // опрос ещё не прошёл — страница сама запросит список
  data.bans = CTL.listBans(); data.statuses = CTL.statuses(); data.awards = CTL.listAwards();
  // статистика призёров прошлых месяцев (для их профилей и медалей), даже если в этом месяце они не играли
  if (CFG.gameLogUnit) data.awardsP = [...new Set(data.awards.map(a => a.sid))].slice(0, 60).map(sid => withSkill(STATS.player(sid))).filter(Boolean);
  if (CFG.gameLogUnit) { data.stats = { period: GL.month(now()), players: statsTop(GL.month(now())).slice(0, 100) }; if (u) data.myStats = withSkill(STATS.player(u.steamid)) || null; if (LEAGUES_ENABLED) { data.leagues = SKILL.board(10); if (u) data.mySkill = SKILL.info(u.steamid); } } // UPD: лиги выключены — их данные на страницу не отдаём
  const js = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
  // страница личная: браузер каждый раз сверяется с сервером и не качает её заново, если ничего не изменилось
  const etag = '"' + INDEX.tag + "-" + sha(js).slice(0, 16) + '"';
  const head = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache", vary: "Cookie", etag };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, head); return res.end(); }
  const body = INDEX.a + "<script>window.TSRV=" + js + "</script>" + INDEX.b;
  res.writeHead(200, { ...head, "content-length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

// ---------- сервер ----------
const BIG_BODY = new Set(["/api/clans/create", "/api/clans/edit"]); // картинки клана
const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "SAMEORIGIN" };
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let url; try { url = new URL(req.url, CFG.site); } catch (e) { return send(res, 400, "bad url"); }
  try {
    if (url.pathname.startsWith("/auth/")) { if (await authRoutes(req, res, url)) return; return send(res, 404, "Not found"); }
    if (url.pathname === "/api/clans/img" && req.method === "GET") return clanImg(req, res, url);
    if (url.pathname.startsWith("/api/")) {
      const h = (R[req.method] || new Map()).get(url.pathname);
      if (!h) return fail(res, 404, "Нет такого метода");
      if (req.method === "POST") {
        // защита от подделки запросов с чужих сайтов
        if (req.headers["x-tasher"] !== "1") return fail(res, 403, "Запрос отклонён");
        const o = req.headers.origin; if (o && o !== new URL(CFG.site).origin) return fail(res, 403, "Запрос отклонён");
      }
      const ctx = { req, res, url, query: url.searchParams, user: sessionUser(req), body: req.method === "POST" ? await readBody(req, BIG_BODY.has(url.pathname) ? 2 * 1024 * 1024 : undefined) : {} };
      if (ctx.body === null || typeof ctx.body !== "object") ctx.body = {};
      return send(res, 200, await h(ctx));
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return fail(res, e.code, e.message);
    console.error(new Date().toISOString(), req.method, req.url, e);
    return fail(res, 500, "Ошибка сервера, попробуй позже");
  }
});
server.headersTimeout = 15e3; server.requestTimeout = 30e3;
if (require.main === module) {
  server.listen(CFG.port, CFG.host, () => console.log(`TASHER server: ${CFG.site} (слушает ${CFG.host}:${CFG.port}), база ${CFG.db}, сайт из ${CFG.staticDir}, кейсов ${G.CASES.length}, скины в игру: ${CFG.wpCnf ? "включено, раскрасок " + PAINTS_N : "выключено"}, игровых серверов: ${CFG.gameServers.length}, статистика: ${CFG.gameLogUnit ? "из журнала " + CFG.gameLogUnit : "выключена"}`));
  const stop = () => { server.close(() => { try { db.close(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
module.exports = { server, db, CFG, WP, CTL, STATS };
