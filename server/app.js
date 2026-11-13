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
  startTk: Math.max(0, +(ENV.START_TK || 0)),
  sessionDays: +(ENV.SESSION_DAYS || 30),
  devLogin: ENV.DEV_LOGIN === "1",
};
const SECURE = CFG.site.startsWith("https://");
if (CFG.devLogin && SECURE) { console.error("DEV_LOGIN нельзя включать на боевом сайте (SITE_URL https)."); process.exit(1); }

const db = open(CFG.db);
const now = () => Date.now();
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
  const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
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
function giveItem(uid, it, src, ref) { insItem.run(it.id, uid, it.w, it.s, it.r, it.wear, it.st ? 1 : 0, it.sv ? 1 : 0, it.sp || null, it.fx || 0, it.seed || 0, src, ref || null, now()); return it; }
const pubItem = r => ({ id: r.id, w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, fx: r.fx || undefined, seed: r.seed, t: r.created_at });
function userItems(uid) { return db.prepare("SELECT * FROM items WHERE user_id=? AND state='inv' ORDER BY created_at").all(uid).map(pubItem); }
function takeItems(uid, ids, state) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => typeof x !== "string" || x.length > 40)) bad("Неверный список предметов");
  const uniq = [...new Set(ids)]; const rows = [];
  for (const id of uniq) {
    const r = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(id, uid);
    if (!r) bad("Предмет не найден или уже использован", 409);
    rows.push(r);
  }
  const t = now(); for (const r of rows) db.prepare("UPDATE items SET state=?, closed_at=? WHERE id=?").run(state, t, r.id);
  return rows;
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
  return { user: pubUser(ctx.user), items: userItems(ctx.user.id) };
});

get("/api/cases", () => ({ cases: Object.fromEntries(G.CASES.map(c => [c.k, c.p])) }));

post("/api/cases/open", ctx => {
  const u = needUser(ctx); rateLimit("open:" + u.id, 8, 10e3);
  const c = G.CASE_BY_K.get(String(ctx.body.k || "")); if (!c) bad("Кейс не найден", 404);
  const nRaw = ctx.body.n === undefined ? 1 : ctx.body.n; if (!Number.isInteger(nRaw) || nRaw < 1 || nRaw > 5) bad("Можно открыть от 1 до 5 кейсов");
  const n = c.p ? nRaw : 1;
  return tx(db, () => {
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
    if (!c.p) {
      if (fresh.daily_day === mskDay()) bad("Бесплатный кейс уже открыт сегодня", 409);
      db.prepare("UPDATE users SET daily_day=? WHERE id=?").run(mskDay(), u.id);
    }
    const price = c.p * n;
    const ref = "case:" + c.k + ":" + crypto.randomBytes(4).toString("hex");
    if (price) addMoney(u.id, "tk", -price, "case", ref, { k: c.k, n });
    const items = Array.from({ length: n }, () => giveItem(u.id, G.rollCase(c), "case", c.k));
    const value = items.reduce((s, it) => s + G.itemValue(it), 0);
    db.prepare("INSERT INTO case_opens(user_id,case_k,n,price,value,created_at) VALUES(?,?,?,?,?,?)").run(u.id, c.k, n, price, value, now());
    const after = db.prepare("SELECT tk FROM users WHERE id=?").get(u.id).tk;
    return { items: items.map(it => ({ ...it, t: now() })), tk: after, price };
  });
});

post("/api/items/sell", ctx => {
  const u = needUser(ctx); rateLimit("sell:" + u.id, 20, 10e3);
  return tx(db, () => {
    const rows = takeItems(u.id, ctx.body.ids, "sold");
    const sum = rows.reduce((s, r) => s + Math.max(1, G.itemValue(r)), 0);
    const tk = addMoney(u.id, "tk", sum, "sell", null, { ids: rows.map(r => r.id) });
    return { sold: rows.map(r => r.id), sum, tk };
  });
});

post("/api/upgrade", ctx => {
  const u = needUser(ctx); rateLimit("up:" + u.id, 6, 10e3);
  const t = G.upTarget(ctx.body.target); if (!t) bad("Цель апгрейда не найдена");
  const tkStake = Math.floor(+ctx.body.tk || 0); if (!(tkStake >= 0 && tkStake <= 1e9)) bad("Неверная ставка ТК");
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : []; if (ids.length > 6) bad("Можно поставить до 6 скинов");
  return tx(db, () => {
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
});

// лента последних выпадений (для блока Live)
get("/api/drops", () => {
  const rows = db.prepare(`SELECT i.w,i.s,i.r,i.wear,i.st,i.sv,i.sp,i.src,i.src_ref,i.created_at,u.name,u.id uid FROM items i JOIN users u ON u.id=i.user_id
    WHERE i.src IN ('case','upgrade') ORDER BY i.created_at DESC LIMIT 30`).all();
  return { drops: rows.map(r => ({ n: r.name || ("Player" + r.uid), w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, src: r.src, c: r.src === "case" ? r.src_ref : null, t: r.created_at })) };
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
  const cur = ctx.body.cur === "rub" ? "rub" : ctx.body.cur === "tk" ? "tk" : bad("Валюта: tk или rub");
  const delta = Math.trunc(+ctx.body.delta); if (!delta || Math.abs(delta) > 1e8) bad("Неверная сумма");
  const reason = String(ctx.body.reason || "").trim().slice(0, 200); if (!reason) bad("Укажи причину");
  const target = db.prepare("SELECT * FROM users WHERE id=? OR steamid=?").get(+ctx.body.user || -1, String(ctx.body.user || ""));
  if (!target) bad("Игрок не найден", 404);
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
  tx(db, () => {
    if (!u) {
      db.prepare("INSERT INTO users(steamid,name,avatar,role,created_at,last_login) VALUES(?,?,?,?,?,?)").run(steamid, prof ? prof.name : "", prof ? prof.avatar : "", CFG.owners.has(steamid) ? "owner" : "player", t, t);
      u = db.prepare("SELECT * FROM users WHERE steamid=?").get(steamid);
      if (CFG.startTk) addMoney(u.id, "tk", CFG.startTk, "welcome");
    } else {
      db.prepare("UPDATE users SET last_login=?, name=COALESCE(?,name), avatar=COALESCE(?,avatar), role=CASE WHEN ? THEN 'owner' ELSE role END WHERE id=?")
        .run(t, prof ? prof.name : null, prof ? prof.avatar : null, CFG.owners.has(steamid) ? 1 : 0, u.id);
    }
  });
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
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
const DENY = /^\/(server|tools|\.git|\.github|node_modules)(\/|$)|\/\.[^/]/;
function serveStatic(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, "bad path"); }
  if (DENY.test(p) || p.includes("\0")) return send(res, 404, "Not found");
  if (p.endsWith("/")) p += "index.html";
  if (p === "/index.html") return serveIndex(req, res);
  const file = path.join(CFG.staticDir, p);
  if (!file.startsWith(CFG.staticDir + path.sep)) return send(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(file).toLowerCase();
    const longCache = url.search.includes("v=") || p.startsWith("/img/sk/");
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "content-length": st.size, "cache-control": ext === ".html" ? "no-cache" : longCache ? "public, max-age=31536000, immutable" : "public, max-age=3600", "last-modified": st.mtime.toUTCString() });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// главная страница: сервер вписывает в неё данные вошедшего игрока, чтобы сайт сразу открылся в нужном состоянии
let INDEX = { mtime: 0, a: "", b: "" };
function serveIndex(req, res) {
  const file = path.join(CFG.staticDir, "index.html");
  let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, "Not found"); }
  if (st.mtimeMs !== INDEX.mtime) {
    const html = fs.readFileSync(file, "utf8"); const i = html.indexOf("<head>") + 6;
    INDEX = { mtime: st.mtimeMs, a: html.slice(0, i), b: html.slice(i) };
  }
  const u = sessionUser(req);
  const data = u ? { user: pubUser(u), items: userItems(u.id) } : { user: null };
  const js = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
  const body = INDEX.a + "<script>window.TSRV=" + js + "</script>" + INDEX.b;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

// ---------- сервер ----------
const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "SAMEORIGIN" };
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let url; try { url = new URL(req.url, CFG.site); } catch (e) { return send(res, 400, "bad url"); }
  try {
    if (url.pathname.startsWith("/auth/")) { if (await authRoutes(req, res, url)) return; return send(res, 404, "Not found"); }
    if (url.pathname.startsWith("/api/")) {
      const h = (R[req.method] || new Map()).get(url.pathname);
      if (!h) return fail(res, 404, "Нет такого метода");
      if (req.method === "POST") {
        // защита от подделки запросов с чужих сайтов
        if (req.headers["x-tasher"] !== "1") return fail(res, 403, "Запрос отклонён");
        const o = req.headers.origin; if (o && o !== new URL(CFG.site).origin) return fail(res, 403, "Запрос отклонён");
      }
      const ctx = { req, res, url, query: url.searchParams, user: sessionUser(req), body: req.method === "POST" ? await readBody(req) : {} };
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
  server.listen(CFG.port, CFG.host, () => console.log(`TASHER server: ${CFG.site} (слушает ${CFG.host}:${CFG.port}), база ${CFG.db}, сайт из ${CFG.staticDir}, кейсов ${G.CASES.length}`));
  const stop = () => { server.close(() => { try { db.close(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
module.exports = { server, db, CFG };
