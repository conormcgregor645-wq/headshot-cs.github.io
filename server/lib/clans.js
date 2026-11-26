"use strict";
// Кланы: создание за ТК, заявки и приём, выход и исключение, передача лидерства, казна в рублях и улучшения из неё.
// Рейтинг клана — сумма очков участников (та же статистика, что в рейтинге игроков). Итоги месяца: топ-5 кланов получают ТК поровну на участников.
const { cleanNick } = require("./nick");

const COST = 50000;                        // создание, ТК
const UP = { col: 99, emb: 149, slots: 249, tag: 199 }; // улучшения из казны, ₽
const DEPOSITS = [50, 100, 250, 500];
const PRIZES = [120000, 80000, 50000, 30000, 20000];
const COLORS = ["#b5e853", "#ff8a3d", "#f5c451", "#3ddc97", "#5aa9ff", "#a78bfa", "#38d3ff", "#ff6b8b", "#eb4b4b"];
const EMBS = ["star", "skull", "bolt", "crown", "wolf", "aim"];
const MAX_SLOTS = 50, AVA_MAX = 200e3, COVER_MAX = 700e3;
const PTS = "MAX(0, k*2 + hs + a + pl*2 + df*3 + rw - tk*5)";

const err = (msg, code = 400) => { const e = new Error(msg); e.code = code; throw e; };
const txt = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function img(v, max) {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(s)) err("Картинка должна быть в формате JPG, PNG или WebP");
  if (s.length > max) err("Картинка слишком большая");
  return s;
}
const validTag = t => /^[A-ZА-ЯЁ0-9]{2,5}$/.test(t);

function makeClans({ db, tx, addMoney, month, prevMonth, now = Date.now, log = console }) {
  const clanOfUser = uid => { const m = db.prepare("SELECT clan_id FROM clan_members WHERE user_id=?").get(uid); return m ? m.clan_id : null; };
  const getClan = id => db.prepare("SELECT * FROM clans WHERE id=?").get(id) || null;
  const members = cid => db.prepare("SELECT u.id, u.name, u.avatar, u.steamid, m.joined_at FROM clan_members m JOIN users u ON u.id=m.user_id WHERE m.clan_id=? ORDER BY m.joined_at").all(cid);
  const needLeader = (u, cid) => { const c = getClan(cid); if (!c) err("Клан не найден", 404); if (c.leader_id !== u.id) err("Это может только лидер клана", 403); return c; };

  // статистика участников за период
  function memberStats(sids, period) {
    if (!sids.length) return new Map();
    const q = db.prepare(`SELECT sid, k, d, rw, ${PTS} pts FROM gstats WHERE period=? AND sid IN (${sids.map(() => "?").join(",")})`).all(period, ...sids);
    return new Map(q.map(r => [r.sid, r]));
  }
  function list(u, t = now()) {
    const mon = month(t), out = [];
    for (const c of db.prepare("SELECT * FROM clans ORDER BY id").all()) {
      const ms = members(c.id), sids = ms.map(m => m.steamid);
      const sm = memberStats(sids, mon), sa = memberStats(sids, "all");
      let month_ = 0, pts = 0, kills = 0, deaths = 0;
      // «Побед» — сколько раз клан занимал 1 место в рейтинге кланов месяца (а не сумма выигранных раундов участников)
      const wins = db.prepare("SELECT COUNT(*) n FROM clan_awards WHERE clan_id=? AND place=1").get(c.id).n;
      const mem = ms.map(m => {
        const a = sm.get(m.steamid) || {}, b = sa.get(m.steamid) || {};
        month_ += a.pts || 0; pts += b.pts || 0; kills += a.k || 0; deaths += a.d || 0;
        return { id: m.id, n: m.name || ("Player" + m.id), av: m.avatar, sid: m.steamid, lead: m.id === c.leader_id, mpts: a.pts || 0, pts: b.pts || 0, k: a.k || 0, d: a.d || 0 };
      });
      // лидер первым, дальше по очкам за месяц
      mem.sort((x, y) => (y.lead - x.lead) || (y.mpts - x.mpts));
      out.push({ id: c.id, n: c.name, t: c.tag, c: c.color, emb: c.emb || null, d: c.descr, ava: c.ava || null, cover: c.cover || null, slots: c.slots,
        members: mem, month: month_, pts, kills, kd: deaths ? +(kills / deaths).toFixed(2) : kills, wins, created: c.created_at });
    }
    const mine = u ? clanOfUser(u.id) : null;
    const my = mine ? { id: mine, bank: getClan(mine).bank, lead: getClan(mine).leader_id === u.id,
      apps: getClan(mine).leader_id === u.id ? db.prepare("SELECT a.id, u.name n, u.avatar av, u.steamid sid, a.created_at t FROM clan_apps a JOIN users u ON u.id=a.user_id WHERE a.clan_id=? ORDER BY a.id").all(mine) : [],
      log: db.prepare("SELECT delta v, what t, created_at d FROM clan_log WHERE clan_id=? ORDER BY id DESC LIMIT 20").all(mine) } : null;
    const myApps = u ? db.prepare("SELECT clan_id FROM clan_apps WHERE user_id=?").all(u.id).map(r => r.clan_id) : [];
    const awards = db.prepare("SELECT period, place, clan_id id, name n, pts, prize FROM clan_awards ORDER BY period DESC, place LIMIT 50").all();
    return { clans: out, my, myApps, awards, rules: { COST, UP, DEPOSITS, PRIZES, COLORS, EMBS, MAX_SLOTS } };
  }

  function create(u, b) {
    return tx(() => {
      if (clanOfUser(u.id)) err("Ты уже в клане");
      const name = cleanNick(txt(b.name, 24)), tag = txt(b.tag, 5).toUpperCase();
      if (name.length < 3) err("Название — от 3 до 24 символов");
      if (!validTag(tag)) err("Тег — от 2 до 5 букв или цифр");
      // сравнение без учёта регистра и для русских букв (SQLite NOCASE понимает только латиницу)
      if (db.prepare("SELECT name FROM clans").all().some(r => r.name.toLowerCase() === name.toLowerCase())) err("Клан с таким названием уже есть", 409);
      if (db.prepare("SELECT 1 FROM clans WHERE tag=?").get(tag)) err(`Тег [${tag}] уже занят, придумай другой`, 409);
      const color = COLORS.includes(b.color) ? b.color : COLORS[0];
      const ava = img(b.ava, AVA_MAX), cover = img(b.cover, COVER_MAX), t = now();
      addMoney(u.id, "tk", -COST, "clan", "create", { what: `Создание клана [${tag}]` });
      const id = db.prepare("INSERT INTO clans(name,tag,color,descr,ava,cover,leader_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(name, tag, color, txt(b.desc, 200) || "Новый клан.", ava, cover, u.id, t).lastInsertRowid;
      db.prepare("INSERT INTO clan_members(user_id,clan_id,joined_at) VALUES(?,?,?)").run(u.id, id, t);
      db.prepare("DELETE FROM clan_apps WHERE user_id=?").run(u.id);
      log.log(`[clan] ${u.name}(${u.id}) создал клан [${tag}] ${name}`);
      return { id };
    });
  }
  function apply(u, cid) {
    const c = getClan(cid); if (!c) err("Клан не найден", 404);
    if (clanOfUser(u.id)) err("Ты уже в клане");
    if (members(cid).length >= c.slots) err(`В клане нет мест: максимум ${c.slots} человек`);
    if (db.prepare("SELECT COUNT(*) n FROM clan_apps WHERE user_id=?").get(u.id).n >= 5) err("Можно подать не больше 5 заявок сразу");
    db.prepare("INSERT OR IGNORE INTO clan_apps(clan_id,user_id,created_at) VALUES(?,?,?)").run(cid, u.id, now());
    return { ok: true };
  }
  function cancelApp(u, cid) { db.prepare("DELETE FROM clan_apps WHERE clan_id=? AND user_id=?").run(cid, u.id); return { ok: true }; }
  function decide(u, appId, accept) {
    return tx(() => {
      const a = db.prepare("SELECT * FROM clan_apps WHERE id=?").get(appId); if (!a) err("Заявка не найдена", 404);
      const c = needLeader(u, a.clan_id);
      db.prepare("DELETE FROM clan_apps WHERE id=?").run(appId);
      if (!accept) return { ok: true };
      if (clanOfUser(a.user_id)) err("Игрок уже вступил в другой клан", 409);
      if (members(c.id).length >= c.slots) err("В клане нет мест — купи ещё места в казне");
      db.prepare("INSERT INTO clan_members(user_id,clan_id,joined_at) VALUES(?,?,?)").run(a.user_id, c.id, now());
      db.prepare("DELETE FROM clan_apps WHERE user_id=?").run(a.user_id);
      return { ok: true };
    });
  }
  function leave(u) {
    return tx(() => {
      const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане");
      const c = getClan(cid), ms = members(cid);
      if (c.leader_id === u.id && ms.length > 1) err("Сначала передай лидерство другому участнику");
      db.prepare("DELETE FROM clan_members WHERE user_id=?").run(u.id);
      if (ms.length === 1) {
        // последний участник уходит — клан распускается, казна возвращается ему
        if (c.bank > 0) addMoney(u.id, "rub", c.bank, "clan", "clan:" + cid, { what: `Казна распущенного клана [${c.tag}]` });
        db.prepare("DELETE FROM clan_apps WHERE clan_id=?").run(cid);
        db.prepare("DELETE FROM clan_log WHERE clan_id=?").run(cid);
        db.prepare("DELETE FROM clans WHERE id=?").run(cid);
        log.log(`[clan] клан [${c.tag}] распущен`);
        return { disbanded: true };
      }
      return { ok: true };
    });
  }
  function kick(u, uid) {
    const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане"); needLeader(u, cid);
    if (uid === u.id) err("Себя исключить нельзя");
    const r = db.prepare("DELETE FROM clan_members WHERE user_id=? AND clan_id=?").run(uid, cid); if (!r.changes) err("Игрок не в твоём клане", 404);
    return { ok: true };
  }
  function transfer(u, uid) {
    const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане"); needLeader(u, cid);
    if (clanOfUser(uid) !== cid) err("Игрок не в твоём клане", 404);
    db.prepare("UPDATE clans SET leader_id=? WHERE id=?").run(uid, cid);
    return { ok: true };
  }
  function edit(u, b) {
    const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане"); const c = needLeader(u, cid);
    const descr = b.desc != null ? txt(b.desc, 200) : c.descr;
    const ava = b.ava !== undefined ? img(b.ava, AVA_MAX) : c.ava, cover = b.cover !== undefined ? img(b.cover, COVER_MAX) : c.cover;
    db.prepare("UPDATE clans SET descr=?, ava=?, cover=? WHERE id=?").run(descr, ava, cover, cid);
    return { ok: true };
  }
  function deposit(u, v) {
    if (!DEPOSITS.includes(v)) err("Пополнить можно на " + DEPOSITS.join(", ") + " ₽");
    return tx(() => {
      const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане");
      addMoney(u.id, "rub", -v, "clan", "clan:" + cid, { what: `${u.name || "Игрок"} пополнил казну` });
      db.prepare("UPDATE clans SET bank=bank+? WHERE id=?").run(v, cid);
      db.prepare("INSERT INTO clan_log(clan_id,user_id,delta,what,created_at) VALUES(?,?,?,?,?)").run(cid, u.id, v, `${u.name || "Игрок"} пополнил казну`, now());
      return { bank: getClan(cid).bank };
    });
  }
  // траты из казны (история — в clan_log)
  function spend(c, u, v, what) {
    if (c.bank < v) err(`В казне не хватает ${v - c.bank} ₽`, 402);
    db.prepare("UPDATE clans SET bank=bank-? WHERE id=?").run(v, c.id);
    db.prepare("INSERT INTO clan_log(clan_id,user_id,delta,what,created_at) VALUES(?,?,?,?,?)").run(c.id, u.id, -v, what, now());
  }
  function upgrade(u, b) {
    return tx(() => {
      const cid = clanOfUser(u.id); if (!cid) err("Ты не в клане"); const c = needLeader(u, cid);
      switch (b.what) {
        case "color": { if (!COLORS.includes(b.v)) err("Неверный цвет"); if (c.color === b.v) return { bank: c.bank }; spend(c, u, UP.col, "Новый цвет клана"); db.prepare("UPDATE clans SET color=? WHERE id=?").run(b.v, cid); break; }
        case "emb": {
          const v = b.v ? String(b.v) : ""; if (v && !EMBS.includes(v)) err("Неверная эмблема"); if ((c.emb || "") === v) return { bank: c.bank };
          if (v) spend(c, u, UP.emb, "Новая эмблема"); db.prepare("UPDATE clans SET emb=? WHERE id=?").run(v, cid); break;
        }
        case "slots": { if (c.slots >= MAX_SLOTS) err("Уже максимум мест"); spend(c, u, UP.slots, "+5 мест в клане"); db.prepare("UPDATE clans SET slots=MIN(?, slots+5) WHERE id=?").run(MAX_SLOTS, cid); break; }
        case "tag": {
          const tag = txt(b.v, 5).toUpperCase(); if (!validTag(tag)) err("Тег — от 2 до 5 букв или цифр"); if (tag === c.tag) return { bank: c.bank };
          if (db.prepare("SELECT 1 FROM clans WHERE tag=? AND id<>?").get(tag, cid)) err(`Тег [${tag}] уже занят`, 409);
          spend(c, u, UP.tag, `Новый тег [${tag}]`); db.prepare("UPDATE clans SET tag=? WHERE id=?").run(tag, cid); break;
        }
        default: err("Неизвестное улучшение");
      }
      return { bank: getClan(cid).bank };
    });
  }
  // итоги месяца для кланов: топ-5 по очкам за прошлый месяц, приз делится поровну на участников
  function runAwards(t = now()) {
    const prev = prevMonth(month(t));
    if (db.prepare("SELECT 1 FROM clan_awards WHERE period=? LIMIT 1").get(prev)) return null;
    const ranked = db.prepare("SELECT id FROM clans").all().map(c => {
      const ms = members(c.id), sm = memberStats(ms.map(m => m.steamid), prev);
      return { c: getClan(c.id), ms, pts: ms.reduce((s, m) => s + ((sm.get(m.steamid) || {}).pts || 0), 0) };
    }).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, PRIZES.length);
    if (!ranked.length) return null;
    tx(() => ranked.forEach((x, i) => {
      const each = Math.floor(PRIZES[i] / Math.max(1, x.ms.length));
      db.prepare("INSERT INTO clan_awards(period,place,clan_id,name,pts,prize,created_at) VALUES(?,?,?,?,?,?,?)").run(prev, i + 1, x.c.id, x.c.name, x.pts, PRIZES[i], t);
      for (const m of x.ms) addMoney(m.id, "tk", each, "clan_prize", "clan:" + x.c.id, { what: `${i + 1} место клана [${x.c.tag}] за ${prev}` });
    }));
    log.log(`[clan] итоги ${prev}: ${ranked.map((x, i) => `${i + 1}. [${x.c.tag}] ${x.pts}`).join(", ")}`);
    return prev;
  }
  const tagOf = uid => { const cid = clanOfUser(uid); return cid ? getClan(cid).tag : null; };
  return { list, create, apply, cancelApp, decide, leave, kick, transfer, edit, deposit, upgrade, runAwards, clanOfUser, tagOf };
}

module.exports = { makeClans, COST, UP, PRIZES, COLORS, EMBS };
