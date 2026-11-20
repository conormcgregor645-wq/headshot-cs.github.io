"use strict";
const { MODES: FUN_MODES } = require("./fun");
// Управление сервером с сайта: баны (действуют в игре), статусы игроков, итоги месяца, команды RCON.
const { cleanNick } = require("./nick");

const STEAM64 = 76561197960265728n;
const TIERS = ["VIP", "PREMIUM", "ELITE", "LEGEND", "TITAN", "KING"];
const DAY = 864e5;
// карты, на которые админ может переключить сервер с сайта (настройка GAME_MAPS заменяет список)
const DEFAULT_MAPS = ["de_mirage", "de_dust2", "de_inferno", "de_nuke", "de_ancient", "de_anubis", "de_vertigo", "de_overpass", "de_train", "cs_office", "cs_italy"];

// SteamID в любом виде -> SteamID64 (строка) или null
function toSid64(v) {
  const s = String(v == null ? "" : v).trim();
  let m;
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?$/i))) return m[1];
  if (/^7656119\d{10}$/.test(s)) return s;
  if ((m = s.match(/^STEAM_[0-5]:([01]):(\d{1,10})$/i))) return String(STEAM64 + BigInt(m[2]) * 2n + BigInt(m[1]));
  if ((m = s.match(/^\[?U:1:(\d{1,10})\]?$/i))) return String(STEAM64 + BigInt(m[1]));
  return null;
}
// SteamID64 -> STEAM_1:Y:Z (так SteamID показывают в банлистах)
function toSteam2(sid) {
  try { const n = BigInt(sid) - STEAM64; if (n < 0n) return sid; return `STEAM_1:${n % 2n}:${n / 2n}`; } catch (e) { return String(sid); }
}
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthRu = p => { const [y, m] = String(p).split("-").map(Number); return (MONTHS_RU[m - 1] || "") + " " + y; };
const prevMonth = p => { const [y, m] = p.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
// текст для консоли сервера: без кавычек, точек с запятой и переводов строк (иначе можно дописать свою команду)
const consoleText = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u2028\u2029"';\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function makeControl({ db, tx, stats, month, rcon, servers, maps, log = console, now = Date.now, onStatusChange = () => {}, onSanction = () => {} }) {
  const MAPS = (maps && maps.length ? maps : DEFAULT_MAPS).filter(m => /^[a-z0-9_]{3,40}$/.test(m));
  const srv0 = () => servers[0] || null;

  // ---------- имена ----------
  function nameOf(sid) {
    const g = db.prepare("SELECT name FROM gplayers WHERE sid=?").get(sid); if (g && g.name) return g.name;
    const u = db.prepare("SELECT name FROM users WHERE steamid=?").get(sid); if (u && u.name) return u.name;
    return "";
  }
  // цель из формы: SteamID в любом виде или ник игрока, который заходил на сервер или на сайт
  function resolve(target) {
    const raw = String(target == null ? "" : target).trim().slice(0, 100);
    if (!raw) return { error: "Укажи SteamID или ник игрока" };
    const sid = toSid64(raw); if (sid) return { sid, name: nameOf(sid) };
    const n = cleanNick(raw); if (!n) return { error: "Укажи SteamID или ник игрока" };
    const rows = db.prepare("SELECT sid, name FROM gplayers WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC").all(n);
    const urows = db.prepare("SELECT steamid sid, name FROM users WHERE name = ? COLLATE NOCASE").all(n);
    const sids = [...new Set([...rows, ...urows].map(r => r.sid))];
    if (sids.length === 1) return { sid: sids[0], name: (rows[0] || urows[0]).name };
    if (sids.length > 1) return { error: `Игроков с ником «${n}» несколько — укажи SteamID` };
    return { error: `Игрок «${n}» не найден. Укажи SteamID (STEAM_1:…, 7656… или ссылку на профиль)` };
  }

  // ---------- баны, муты, геги ----------
  // kind: ban — не пускать на сервер; mute — без голоса; gag — без чата; silence — мут и гег сразу
  const KINDS = { ban: "Бан", mute: "Мут", gag: "Гег", silence: "Мут и гег" };
  const activeBanQ = db.prepare("SELECT * FROM bans WHERE sid=? AND kind='ban' AND lifted_at IS NULL AND (until=0 OR until>?) ORDER BY id DESC LIMIT 1");
  const activeBan = sid => activeBanQ.get(sid, now()) || null;
  const activeOfQ = db.prepare("SELECT * FROM bans WHERE sid=? AND kind IN (SELECT value FROM json_each(?)) AND lifted_at IS NULL AND (until=0 OR until>?) ORDER BY until=0 DESC, until DESC LIMIT 1");
  const activeMute = sid => activeOfQ.get(sid, '["mute","silence"]', now()) || null;
  const activeGag = sid => activeOfQ.get(sid, '["gag","silence"]', now()) || null;
  const pubBan = b => {
    const t = now(), active = !b.lifted_at && (b.until === 0 || b.until > t), kind = KINDS[b.kind] ? b.kind : "ban";
    const mins = b.until ? Math.max(1, Math.round((b.until - b.created_at) / 60e3)) : 0;
    return { id: b.id, kind, kindRu: KINDS[kind], sid: b.sid, sid2: toSteam2(b.sid), n: b.name || "Игрок", reason: b.reason, d: b.created_at, until: b.until, perm: b.until === 0,
      days: b.until ? Math.max(1, Math.round((b.until - b.created_at) / DAY)) : 0, mins, by: b.by_name || "Админ", active, lifted: !!b.lifted_at };
  };
  // все действующие муты и геги (для плагина в игре): sid -> {mute, gag} с причиной и сроком
  function activeSanctions() {
    const t = now(), out = new Map();
    for (const b of db.prepare("SELECT * FROM bans WHERE kind IN ('mute','gag','silence') AND lifted_at IS NULL AND (until=0 OR until>?) ORDER BY id").all(t)) {
      const x = out.get(b.sid) || { sid: b.sid, n: b.name }; out.set(b.sid, x);
      const put = k => { const cur = x[k]; if (!cur || (cur.until !== 0 && (b.until === 0 || b.until > cur.until))) x[k] = { until: b.until, reason: b.reason }; };
      if (b.kind === "mute" || b.kind === "silence") put("mute");
      if (b.kind === "gag" || b.kind === "silence") put("gag");
    }
    return [...out.values()];
  }
  const listBans = (limit = 300) => db.prepare("SELECT * FROM bans ORDER BY id DESC LIMIT ?").all(limit).map(pubBan);

  async function rconCmd(cmd) {
    const s = srv0(); if (!s || !rcon.pass) throw new Error("RCON не настроен");
    return rcon.exec(s, rcon.pass, cmd, 3000);
  }
  async function status() { return rcon.parseStatus(await rconCmd("status")); }

  // выгнать игрока по SteamID: номер на сервере берём из status по нику (точнее всего), иначе из журнала
  const lastKick = new Map();
  async function kickSid(sid, msg, hintUid) {
    const on = stats.online().get(sid);
    const name = on ? on.n : nameOf(sid);
    let id = null;
    try { const st = (await status()).filter(p => !p.bot && p.n === name); if (st.length === 1) id = st[0].id; } catch (e) {}
    if (id == null) id = Number.isInteger(hintUid) ? hintUid : on ? on.uid : null;
    if (id == null) return false;
    const out = await rconCmd(`kickid ${id} "${consoleText(msg, 120)}"`);
    if (/unknown command/i.test(out)) throw new Error("сервер не знает команду kickid");
    log.log(`[ban] выгнан ${name || sid} (${sid}), номер ${id}`);
    return true;
  }
  // забаненный появился в журнале или в списке игроков — выгоняем (не чаще раза в 5 секунд на игрока:
  // подключение и вход в игру идут друг за другом, а переподключение после кика занимает дольше)
  async function enforce(sid, hintUid) {
    if (!sid || !rcon.pass) return false;
    const b = activeBan(sid); if (!b) return false;
    const t = now(); if (t - (lastKick.get(sid) || 0) < 5e3) return false;
    lastKick.set(sid, t);
    const left = b.until ? `до ${new Date(b.until + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} МСК` : "навсегда";
    try { return await kickSid(sid, `Бан ${left}. Причина: ${b.reason}. tashercs.ru/#bans`, hintUid); }
    catch (e) { log.error("[ban] не удалось выгнать:", e.message); return false; }
  }
  setInterval(() => { const t = now(); for (const [k, v] of lastKick) if (t - v > 60e3) lastKick.delete(k); }, 60e3).unref();

  // срок: mins (минуты, для мута и гега) или days (дни); 0 — навсегда
  async function ban(admin, body) {
    const kind = body.kind == null ? "ban" : String(body.kind); if (!KINDS[kind]) return { error: "Неизвестный тип наказания" };
    const r = resolve(body.target); if (r.error) return { error: r.error };
    const reason = consoleText(body.reason, 100); if (reason.length < 2) return { error: "Укажи причину" };
    let ms;
    if (body.mins != null) { const m = Number(body.mins); if (!Number.isInteger(m) || m < 0 || m > 3650 * 1440) return { error: "Срок: от 1 минуты до 10 лет или 0 — навсегда" }; ms = m * 60e3; }
    else { const days = Number(body.days); if (!Number.isInteger(days) || days < 0 || days > 3650) return { error: "Срок: от 1 до 3650 дней или 0 — навсегда" }; ms = days * DAY; }
    const name = cleanNick(body.name) || r.name || "Игрок";
    if (kind === "ban" && activeBan(r.sid)) return { error: `У ${name} уже есть активный бан`, code: 409 };
    if ((kind === "mute" || kind === "silence") && activeMute(r.sid)) return { error: `У ${name} уже есть активный мут`, code: 409 };
    if ((kind === "gag" || kind === "silence") && activeGag(r.sid)) return { error: `У ${name} уже есть активный гег`, code: 409 };
    const t = now();
    const id = db.prepare("INSERT INTO bans(sid,name,reason,created_at,until,by_id,by_name,kind) VALUES(?,?,?,?,?,?,?,?)")
      .run(r.sid, name, reason, t, ms ? t + ms : 0, admin.id, admin.name || ("Player" + admin.id), kind).lastInsertRowid;
    log.log(`[admin] ${admin.name}(${admin.id}) ${KINDS[kind].toLowerCase()} ${name} ${r.sid} на ${ms ? Math.round(ms / 60e3) + " мин." : "∞"}: ${reason}`);
    const out = { ban: pubBan(db.prepare("SELECT * FROM bans WHERE id=?").get(id)), kicked: false };
    if (kind === "ban") {
      lastKick.delete(r.sid);
      // если игрок сейчас на сервере — сразу выгоняем (номер по журналу, а если сайт его ещё не видел — по нику в status)
      out.kicked = rcon.pass ? await enforce(r.sid) : false;
    } else onSanction();
    return out;
  }
  function unban(admin, id) {
    const r = db.prepare("UPDATE bans SET lifted_at=?, lifted_by=? WHERE id=? AND lifted_at IS NULL").run(now(), admin.name || ("Player" + admin.id), Number.isInteger(id) ? id : -1);
    if (!r.changes) return { error: "Бан не найден или уже снят", code: 404 };
    const b = db.prepare("SELECT * FROM bans WHERE id=?").get(id);
    log.log(`[admin] ${admin.name}(${admin.id}) снял ${(KINDS[b.kind] || "Бан").toLowerCase()} #${id}`);
    if (b.kind !== "ban") onSanction();
    return { ban: pubBan(b) };
  }

  // ---------- статусы ----------
  // действующий статус игрока — самый старший из невыданных назад и неистёкших
  function statuses() {
    const t = now(), out = new Map();
    const rows = db.prepare("SELECT * FROM grants WHERE revoked_at IS NULL AND until>? ORDER BY until DESC").all(t);
    for (const g of rows) {
      const cur = out.get(g.sid), rank = TIERS.indexOf(g.tier);
      if (!cur || rank > TIERS.indexOf(cur.t)) out.set(g.sid, { sid: g.sid, t: g.tier, u: g.until, f: g.from_at, src: g.src, note: g.note });
    }
    // «действует с» — начало самой ранней из подряд идущих выдач этого статуса
    for (const s of out.values()) for (const g of rows) if (g.sid === s.sid && g.tier === s.t && g.from_at < s.f) s.f = g.from_at;
    return [...out.values()].map(s => ({ ...s, n: nameOf(s.sid) || "Игрок", sid2: toSteam2(s.sid) })).sort((a, b) => TIERS.indexOf(b.t) - TIERS.indexOf(a.t) || b.u - a.u);
  }
  // выдать статус: та же выдача от админа или из магазина продлевается, иначе новая идёт следом за действующей того же статуса
  function addGrant(sid, tier, days, src, note, by) {
    const t = now();
    const ex = db.prepare("SELECT * FROM grants WHERE sid=? AND tier=? AND src IN ('admin','shop') AND revoked_at IS NULL AND until>? ORDER BY until DESC LIMIT 1").get(sid, tier, t);
    if (ex) { db.prepare("UPDATE grants SET until=? WHERE id=?").run(ex.until + days * DAY, ex.id); return { extended: true, until: ex.until + days * DAY }; }
    const last = db.prepare("SELECT MAX(until) u FROM grants WHERE sid=? AND tier=? AND revoked_at IS NULL AND until>?").get(sid, tier, t);
    const from = Math.max(t, (last && last.u) || 0);
    db.prepare("INSERT INTO grants(sid,tier,src,note,created_at,from_at,until,by_name) VALUES(?,?,?,?,?,?,?,?)").run(sid, tier, src, consoleText(note, 100), t, from, from + days * DAY, by || "");
    return { extended: from > t, until: from + days * DAY };
  }
  function grant(admin, body) {
    const r = resolve(body.target); if (r.error) return { error: r.error };
    const tier = TIERS.includes(body.tier) ? body.tier : null; if (!tier) return { error: "Статус: " + TIERS.join(", ") };
    const days = Number(body.days); if (!Number.isInteger(days) || days < 1 || days > 3650) return { error: "Срок: от 1 до 3650 дней" };
    const by = admin.name || ("Player" + admin.id);
    const res = tx(() => addGrant(r.sid, tier, days, "admin", body.note, by));
    log.log(`[admin] ${by}(${admin.id}) статус ${tier} на ${days} дн. -> ${r.name || r.sid} (${res.extended ? "продлён" : "выдан"})`);
    onStatusChange();
    return { sid: r.sid, name: r.name || "Игрок", extended: res.extended, statuses: statuses() };
  }
  function revoke(admin, sid) {
    if (!/^\d{17}$/.test(String(sid || ""))) return { error: "Неверный SteamID" };
    const r = db.prepare("UPDATE grants SET revoked_at=? WHERE sid=? AND revoked_at IS NULL AND until>?").run(now(), sid, now());
    if (!r.changes) return { error: "У игрока нет действующего статуса", code: 404 };
    log.log(`[admin] ${admin.name}(${admin.id}) снял статусы с ${sid}`);
    onStatusChange();
    return { statuses: statuses() };
  }

  // ---------- итоги месяца ----------
  // после конца месяца (по Москве): места 1–3 получают KING, 4–10 — LEGEND на 30 дней, весь топ-10 — медали
  function runAwards(t = now()) {
    const prev = prevMonth(month(t));
    if (db.prepare("SELECT 1 FROM awards WHERE period=? LIMIT 1").get(prev)) return null;
    const top = stats.top(prev, 10).filter(p => p.pts > 0);
    if (!top.length) return null;
    tx(() => {
      top.forEach((p, i) => {
        const place = i + 1, tier = place <= 3 ? "KING" : "LEGEND";
        db.prepare("INSERT INTO awards(period,place,sid,name,pts,created_at) VALUES(?,?,?,?,?,?)").run(prev, place, p.sid, p.n, p.pts, t);
        db.prepare("INSERT INTO grants(sid,tier,src,note,created_at,from_at,until,by_name) VALUES(?,?,?,?,?,?,?,?)").run(p.sid, tier, "award", `${place} место · ${monthRu(prev)}`, t, t, t + 30 * DAY, "Итоги месяца");
      });
    });
    onStatusChange();
    log.log(`[awards] итоги ${prev}: ${top.map((p, i) => `${i + 1}. ${p.n} (${p.pts})`).join(", ")}`);
    return prev;
  }
  const listAwards = () => db.prepare("SELECT period, place, sid, name n, pts FROM awards ORDER BY period DESC, place LIMIT 240").all();

  // ---------- команды сервера ----------
  async function serverInfo() {
    const st = await status();
    return { players: st.map(p => ({ id: p.id, n: p.n, t: p.t, bot: p.bot, sid: p.bot ? null : stats.sidByName(p.n) })), maps: MAPS };
  }
  async function serverAct(admin, body) {
    const by = admin.name || ("Player" + admin.id);
    switch (body.act) {
      case "kick": {
        const id = Number(body.id); if (!Number.isInteger(id) || id < 0 || id > 255) return { error: "Неверный игрок" };
        const st = await status(); const p = st.find(x => x.id === id);
        // игрок мог выйти, а его место занял другой — сверяем ник
        if (!p || (body.n && p.n !== body.n)) return { error: "Игрок уже вышел с сервера", code: 409 };
        const reason = consoleText(body.reason, 80) || "Кик администратором";
        const out = await rconCmd(`kickid ${id} "${reason}"`);
        if (/unknown command/i.test(out)) return { error: "Сервер не знает команду kickid" };
        log.log(`[admin] ${by}(${admin.id}) кик ${p.n} (#${id}): ${reason}`);
        return { ok: true, msg: `${p.n} выгнан с сервера` };
      }
      case "map": {
        const m = String(body.map || ""); if (!MAPS.includes(m)) return { error: "Такой карты нет в списке" };
        await rconCmd(`changelevel ${m}`);
        log.log(`[admin] ${by}(${admin.id}) смена карты на ${m}`);
        return { ok: true, msg: `Сервер переключается на ${m}` };
      }
      case "restart": {
        await rconCmd("mp_restartgame 3");
        log.log(`[admin] ${by}(${admin.id}) рестарт матча`);
        return { ok: true, msg: "Матч перезапустится через 3 секунды" };
      }
      case "special": {
        const k = String(body.kind || "");
        if (k !== "random" && k !== "off" && !FUN_MODES[k]) return { error: "Неизвестный режим особого раунда" };
        const out = await rconCmd(`css_special ${k}`);
        if (/unknown command/i.test(out)) return { error: "На сервере старая версия плагина TASHER Style — запусти vip-setup.sh" };
        log.log(`[admin] ${by}(${admin.id}) особый раунд: ${k}`);
        return { ok: true, msg: k === "off" ? "Особый раунд отменён" : `Следующий раунд — особый: ${k === "random" ? "случайный режим" : FUN_MODES[k]}` };
      }
      case "say": {
        const text = consoleText(body.text, 120); if (!text) return { error: "Напиши сообщение" };
        await rconCmd(`say ${text}`);
        log.log(`[admin] ${by}(${admin.id}) say: ${text}`);
        return { ok: true, msg: "Сообщение отправлено в чат" };
      }
    }
    return { error: "Неизвестное действие" };
  }

  return { addGrant, resolve, activeBan, activeMute, activeGag, activeSanctions, listBans, ban, unban, enforce, statuses, grant, revoke, runAwards, listAwards, serverInfo, serverAct, MAPS };
}

module.exports = { makeControl, toSid64, toSteam2, prevMonth, consoleText, TIERS, DEFAULT_MAPS };
