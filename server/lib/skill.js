"use strict";
// Лиги и ранги: рейтинг силы (как Elo) по журналу CS2.
// Убийство живого игрока: убийца забирает у жертвы очки — тем больше, чем сильнее жертва.
// Боты дают и отнимают мало (у бота постоянная сила BOT_SR). Победа в раунде +1, поражение −1. Тимкилл −5.
// Первые CALIB событий — калибровка: лига не показывается, пока сила не устоится.

const START = 1000, BOT_SR = 950, K_HUMAN = 12, K_BOT = 3, ROUND = 1, TEAMKILL = 5, CALIB = 40;
const LEAGUES = [
  { k: "iron", n: "Железо", min: -Infinity, c: "#8a8f98", chat: "grey" },
  { k: "bronze", n: "Бронза", min: 800, c: "#c4773b", chat: "orange" },
  { k: "silver", n: "Серебро", min: 950, c: "#c0c6cf", chat: "silver" },
  { k: "gold", n: "Золото", min: 1100, c: "#f5c451", chat: "gold" },
  { k: "plat", n: "Платина", min: 1250, c: "#38d3ff", chat: "lightblue" },
  { k: "diamond", n: "Алмаз", min: 1400, c: "#6b8cff", chat: "blue" },
  { k: "master", n: "Мастер", min: 1550, c: "#a78bfa", chat: "purple" },
  { k: "legend", n: "Легенда", min: 1700, c: "#ff4d6d", chat: "red" },
];
const leagueIdx = sr => { let i = 0; for (let k = 0; k < LEAGUES.length; k++) if (sr >= LEAGUES[k].min) i = k; return i; };
const expect = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

function makeSkill({ db, now = Date.now, onLeague = () => {} }) {
  const getQ = db.prepare("SELECT sr, n, peak FROM skill WHERE sid=?");
  const putQ = db.prepare("INSERT INTO skill(sid,sr,n,peak,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(sid) DO UPDATE SET sr=excluded.sr, n=excluded.n, peak=excluded.peak, updated_at=excluded.updated_at");
  const row = sid => getQ.get(sid) || { sr: START, n: 0, peak: START };
  // лига сменилась (или закончилась калибровка) — сообщаем, чтобы обновить тег в чате игры
  const lgOf = r => (r.n >= CALIB ? leagueIdx(r.sr) : -1);
  const put = (sid, r) => {
    const old = getQ.get(sid), before = old ? lgOf(old) : -1;
    putQ.run(sid, r.sr, r.n, Math.max(r.peak, r.n >= CALIB ? r.sr : r.peak), now());
    if (lgOf(r) !== before) { try { onLeague(sid, lgOf(r), before); } catch (e) {} }
  };
  const add = (sid, d) => { const r = row(sid); r.sr = Math.max(0, r.sr + d); r.n += 1; put(sid, r); return r; };

  // события журнала (gamelog.parseLine); разминку не считаем
  function apply(ev, warm) {
    if (!ev || warm || ev.e !== "kill") return;
    const a = ev.a, v = ev.v; if (!a || !v) return;
    const human = p => p && p.sid && !p.bot;
    if (human(a) && human(v) && a.sid === v.sid) return; // самоубийство
    if (a.team && v.team && a.team === v.team) { if (human(a)) add(a.sid, -TEAMKILL); return; }
    if (human(a) && human(v)) {
      const ra = row(a.sid), rv = row(v.sid), d = K_HUMAN * (1 - expect(ra.sr, rv.sr));
      ra.sr += d; ra.n += 1; rv.sr = Math.max(0, rv.sr - d); rv.n += 1; put(a.sid, ra); put(v.sid, rv);
    } else if (human(a) && v.bot) add(a.sid, K_BOT * (1 - expect(row(a.sid).sr, BOT_SR)));
    else if (a.bot && human(v)) add(v.sid, -K_BOT * expect(row(v.sid).sr, BOT_SR));
  }
  // итог раунда: winners/losers — SteamID людей на сервере
  function round(winners, losers) { for (const s of winners) add(s, ROUND); for (const s of losers) add(s, -ROUND); }

  function info(sid) {
    const r = getQ.get(sid); if (!r) return { sr: START, n: 0, calib: true, left: CALIB, lg: null };
    const sr = Math.round(r.sr), calib = r.n < CALIB, i = leagueIdx(r.sr), nx = LEAGUES[i + 1];
    return { sr, n: r.n, calib, left: Math.max(0, CALIB - r.n), peak: Math.round(r.peak), lg: calib ? null : i,
      next: nx ? { n: nx.n, need: Math.max(0, Math.ceil(nx.min - r.sr)) } : null };
  }
  // все откалиброванные: таблица лиг на сайте
  function board(limit = 20) {
    const rows = db.prepare("SELECT s.sid, s.sr, s.n, g.name FROM skill s LEFT JOIN gplayers g ON g.sid=s.sid WHERE s.n>=? ORDER BY s.sr DESC").all(CALIB);
    const count = LEAGUES.map(() => 0); for (const r of rows) count[leagueIdx(r.sr)]++;
    return { leagues: LEAGUES.map((l, i) => ({ k: l.k, n: l.n, min: Number.isFinite(l.min) ? l.min : 0, c: l.c, count: count[i] })), calib: CALIB, total: rows.length,
      top: rows.slice(0, limit).map(r => ({ sid: r.sid, n: r.name || "Игрок", sr: Math.round(r.sr), lg: leagueIdx(r.sr) })) };
  }
  // мягкий сброс в начале сезона: все ближе к середине, калибровка заново
  function softReset(k = 0.5) { db.prepare("UPDATE skill SET sr=?+(sr-?)*?, n=MIN(n,?), peak=?+(sr-?)*?").run(START, START, k, Math.floor(CALIB / 2), START, START, k); }
  return { apply, round, info, board, softReset };
}

module.exports = { makeSkill, LEAGUES, leagueIdx, CALIB, START, BOT_SR };
