"use strict";
// Статистика игроков из журнала CS2 (строки "L 11/18/2026 - 23:53:20: ..." в консоли сервера).
// Формат проверен на настоящем сервере: убийства, входы/выходы, команды, победы в раундах, бомба.

const { cleanNick } = require("./nick");
const STEAM64 = 76561197960265728n;
const TOKEN = /"(.*?)<(\d+)><([^<>]*)><([^<>]*)>"/; // "Ник<2><[U:1:1618774009]><CT>"
function who(s) {
  const m = s.match(TOKEN); if (!m) return null;
  const id = m[3], u = id.match(/^\[U:1:(\d+)\]$/);
  return { n: cleanNick(m[1]) || "Игрок", uid: +m[2], bot: id === "BOT", sid: u ? String(STEAM64 + BigInt(u[1])) : null, team: m[4] === "CT" ? "ct" : m[4] === "TERRORIST" ? "t" : "" };
}
function splitTokens(s) { // два участника: "A<..>" ... "B<..>"
  const re = new RegExp(TOKEN.source, "g"); const out = []; let m;
  while ((m = re.exec(s))) out.push(who(m[0]));
  return out;
}

// разбор одной строки -> событие или null
function parseLine(line) {
  const m = String(line).match(/^L (\d\d)\/(\d\d)\/(\d{4}) - (\d\d):(\d\d):(\d\d): (.*)$/);
  if (!m) return null;
  const t = new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime(), s = m[7];
  let r;
  if ((r = s.match(/^(".*") \[[^\]]*\] killed (".*") \[[^\]]*\] with "([\w-]+)"(?: \(([^)]*)\))?\s*$/))) {
    const [a, v] = [who(r[1]), who(r[2])]; if (!a || !v) return null;
    return { t, e: "kill", a, v, w: r[3], hs: /\bheadshot\b/.test(r[4] || "") };
  }
  if ((r = s.match(/^(".*") assisted killing (".*")\s*$/))) { const [a, v] = splitTokens(s); return a && v ? { t, e: "assist", a, v } : null; }
  if (/^".*" flash-assisted killing /.test(s)) return null;
  if ((r = s.match(/^(".*") \[[^\]]*\] (?:committed suicide|was killed by the bomb|was killed) /))) { const a = who(r[1]); return a ? { t, e: "suicide", a } : null; }
  if ((r = s.match(/^(".*") entered the game\s*$/))) { const a = who(r[1]); return a ? { t, e: "enter", a } : null; }
  // подключение (ещё до входа в игру) — нужно, чтобы сразу выгнать забаненного
  if ((r = s.match(/^(".*") (?:connected, address|STEAM USERID validated)/))) { const a = who(r[1]); return a ? { t, e: "connect", a } : null; }
  if ((r = s.match(/^(".*") disconnected\b/))) { const a = who(r[1]); return a ? { t, e: "leave", a } : null; }
  if ((r = s.match(/^(".*") switched from team <(\w*)> to <(\w*)>/))) { const a = who(r[1]); if (!a) return null; a.team = r[3] === "CT" ? "ct" : r[3] === "TERRORIST" ? "t" : ""; return { t, e: "team", a }; }
  if ((r = s.match(/^(".*") triggered "(Planted_The_Bomb|Defused_The_Bomb)"/))) { const a = who(r[1]); return a ? { t, e: r[2] === "Planted_The_Bomb" ? "plant" : "defuse", a } : null; }
  if ((r = s.match(/^Team "(CT|TERRORIST)" triggered "SFUI_Notice_\w+"/))) return { t, e: "round", win: r[1] === "CT" ? "ct" : "t" };
  // счёт команды после раунда: Team "CT" scored "3" with "5" players
  if ((r = s.match(/^Team "(CT|TERRORIST)" scored "(\d+)" with "\d+" players/))) return { t, e: "score", team: r[1] === "CT" ? "ct" : "t", n: +r[2] };
  if ((r = s.match(/^(?:Started|Loading) map "([\w-]+)"/))) return { t, e: "map", map: r[1] };
  if ((r = s.match(/^World triggered "(Warmup_Start|Warmup_End|Match_Start|Round_Start|Round_End|Game_Commencing)"/))) return { t, e: r[1].toLowerCase() };
  if (/^Log file closed/.test(s)) return { t, e: "logclose" };
  return null;
}

// названия оружия из журнала -> как на сайте
const WEAPON = {
  ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", m4a1_silencer_off: "M4A1-S", awp: "AWP", deagle: "Desert Eagle", usp_silencer: "USP-S", usp_silencer_off: "USP-S",
  glock: "Glock-18", hkp2000: "P2000", p250: "P250", fiveseven: "Five-SeveN", tec9: "Tec-9", cz75a: "CZ75-Auto", elite: "Dual Berettas", revolver: "R8 Revolver",
  famas: "FAMAS", galilar: "Galil AR", aug: "AUG", sg556: "SG 553", ssg08: "SSG 08", scar20: "SCAR-20", g3sg1: "G3SG1",
  mac10: "MAC-10", mp9: "MP9", mp7: "MP7", mp5sd: "MP5-SD", ump45: "UMP-45", p90: "P90", bizon: "PP-Bizon",
  nova: "Nova", xm1014: "XM1014", sawedoff: "Sawed-Off", mag7: "MAG-7", m249: "M249", negev: "Negev", taser: "Zeus x27",
  hegrenade: "Граната", inferno: "Молотов", molotov: "Молотов", incgrenade: "Молотов", knife: "Нож", knife_t: "Нож", bayonet: "Нож",
};
const weaponName = w => WEAPON[w] || (/^knife|bayonet/.test(w) ? "Нож" : w);

const month = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 7); // месяц по Москве: "2026-11"
// сессия не длиннее 12 ч; тишина в журнале дольше 30 мин — считаем, что сервер был выключен
const MAX_SESSION = 12 * 3600e3, GAP = 30 * 60e3;

// накопитель статистики поверх SQLite
function makeStats(db, { bots = true } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS gplayers(sid TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gstats(sid TEXT NOT NULL, period TEXT NOT NULL, k INTEGER NOT NULL DEFAULT 0, d INTEGER NOT NULL DEFAULT 0, hs INTEGER NOT NULL DEFAULT 0,
      a INTEGER NOT NULL DEFAULT 0, tk INTEGER NOT NULL DEFAULT 0, su INTEGER NOT NULL DEFAULT 0, pl INTEGER NOT NULL DEFAULT 0, df INTEGER NOT NULL DEFAULT 0,
      rw INTEGER NOT NULL DEFAULT 0, rp INTEGER NOT NULL DEFAULT 0, pt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sid, period));
    CREATE INDEX IF NOT EXISTS gstats_period ON gstats(period);
    CREATE TABLE IF NOT EXISTS gweapons(sid TEXT NOT NULL, w TEXT NOT NULL, k INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sid, w));`);
  // старые ники в базе приводим к чистому виду (один раз при запуске, дёшево)
  { const fix = db.prepare("UPDATE gplayers SET name=? WHERE sid=?");
    for (const r of db.prepare("SELECT sid, name FROM gplayers").all()) { const c = cleanNick(r.name) || "Игрок"; if (c !== r.name) fix.run(c, r.sid); } }
  const COLS = ["k", "d", "hs", "a", "tk", "su", "pl", "df", "rw", "rp", "pt"];
  const ups = Object.fromEntries(COLS.map(c => [c, db.prepare(`INSERT INTO gstats(sid,period,${c}) VALUES(?,?,?) ON CONFLICT(sid,period) DO UPDATE SET ${c}=${c}+excluded.${c}`)]));
  const upPlayer = db.prepare("INSERT INTO gplayers(sid,name,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(sid) DO UPDATE SET name=excluded.name, last_seen=MAX(last_seen,excluded.last_seen)");
  const upWeapon = db.prepare("INSERT INTO gweapons(sid,w,k) VALUES(?,?,1) ON CONFLICT(sid,w) DO UPDATE SET k=k+1");
  const add = (sid, col, v, t) => { if (!sid || !v) return; ups[col].run(sid, "all", v); ups[col].run(sid, month(t), v); };
  const seen = (p, t) => { if (p && p.sid) upPlayer.run(p.sid, String(p.n).slice(0, 64), t, t); };

  // состояние текущей карты (в памяти): разминка, команды, сессии, счёт на карте для списка игроков
  // nteam: ник -> сторона для всех на сервере (и ботов) — для окна сервера на сайте; score — счёт текущего матча
  const S = { warm: false, team: new Map(), sess: new Map(), live: new Map(), lastT: 0, uid: new Map(), nteam: new Map(), score: { ct: 0, t: 0 } };
  const resetMatch = () => { S.score = { ct: 0, t: 0 }; };
  const live = p => { const k = p.sid || "bot:" + p.n; let x = S.live.get(k); if (!x) S.live.set(k, x = { n: p.n, k: 0, d: 0 }); x.n = p.n; return x; };
  function closeSess(sid, t) { const st = S.sess.get(sid); if (st == null) return; S.sess.delete(sid); add(sid, "pt", Math.round(Math.min(Math.max(0, t - st), MAX_SESSION) / 1000), t); }
  function closeAll(t) { for (const sid of [...S.sess.keys()]) closeSess(sid, t); }

  function apply(ev) {
    if (!ev) return;
    const t = ev.t;
    // большая пауза в журнале — сервер перезапускался: закрываем сессии временем последней строки
    if (S.lastT && t - S.lastT > GAP) { closeAll(S.lastT); S.warm = false; }
    S.lastT = Math.max(S.lastT, t);
    for (const p of [ev.a, ev.v]) if (p && p.team && ev.e !== "leave") S.nteam.set(p.n, p.team);
    for (const p of [ev.a, ev.v]) if (p) { seen(p, t); if (p.sid && ev.e !== "leave") S.uid.set(p.sid, { uid: p.uid, n: p.n }); if (p.sid && p.team) S.team.set(p.sid, p.team); if (p.sid && !S.sess.has(p.sid) && ev.e !== "leave" && ev.e !== "connect") S.sess.set(p.sid, t); }
    switch (ev.e) {
      case "warmup_start": S.warm = true; resetMatch(); break;
      case "warmup_end": case "match_start": S.warm = false; resetMatch(); if (ev.e === "match_start") S.live.clear(); break;
      case "map": resetMatch(); S.live.clear(); break;
      case "score": S.score[ev.team] = ev.n; break;
      case "team": if (ev.a.team) S.nteam.set(ev.a.n, ev.a.team); else S.nteam.delete(ev.a.n); break;
      case "logclose": closeAll(t); S.live.clear(); S.uid.clear(); S.nteam.clear(); resetMatch(); break;
      case "enter": if (ev.a.sid) { closeSess(ev.a.sid, t); S.sess.set(ev.a.sid, t); } break;
      case "leave": if (ev.a.sid) { closeSess(ev.a.sid, t); S.team.delete(ev.a.sid); S.uid.delete(ev.a.sid); } S.live.delete(ev.a.sid || "bot:" + ev.a.n); S.nteam.delete(ev.a.n); break;
      case "kill": {
        if (S.warm) break;
        const { a, v } = ev, same = a.team && a.team === v.team, self = (a.sid && a.sid === v.sid) || (a.bot && v.bot && a.n === v.n);
        if (self) { add(v.sid, "su", 1, t); add(v.sid, "d", 1, t); live(v).d++; break; }
        if (v.bot && !bots) { break; }
        if (a.bot && !bots) { add(v.sid, "d", 1, t); live(v).d++; break; }
        if (same) { add(a.sid, "tk", 1, t); add(v.sid, "d", 1, t); live(v).d++; break; }
        add(a.sid, "k", 1, t); if (ev.hs) add(a.sid, "hs", 1, t); if (a.sid) upWeapon.run(a.sid, weaponName(ev.w));
        add(v.sid, "d", 1, t); live(a).k++; live(v).d++; break;
      }
      case "assist": if (!S.warm && !(ev.v.bot && !bots) && !(ev.a.team && ev.a.team === ev.v.team)) add(ev.a.sid, "a", 1, t); break;
      case "suicide": if (!S.warm) { add(ev.a.sid, "su", 1, t); add(ev.a.sid, "d", 1, t); live(ev.a).d++; } break;
      case "plant": if (!S.warm) add(ev.a.sid, "pl", 1, t); break;
      case "defuse": if (!S.warm) add(ev.a.sid, "df", 1, t); break;
      case "round": if (!S.warm) for (const [sid, team] of S.team) { if (!S.sess.has(sid)) continue; add(sid, "rp", 1, t); if (team === ev.win) add(sid, "rw", 1, t); } break;
    }
  }

  // время текущей (ещё не закрытой) сессии — чтобы «время в игре» шло, пока игрок на сервере
  const openSec = sid => { const st = S.sess.get(sid); return st == null ? 0 : Math.round(Math.min(Math.max(0, Date.now() - st), MAX_SESSION) / 1000); };
  // очки рейтинга: убийство 2, хедшот +1, помощь 1, бомба 2, разминирование 3, победа в раунде 1, тимкилл −5
  const PTS = "MAX(0, k*2 + hs + a + pl*2 + df*3 + rw - tk*5)";
  function top(period, limit = 200) {
    const rows = db.prepare(`SELECT m.sid, p.name, p.last_seen, m.k mk, m.d md, m.hs mhs, m.a ma, m.pt mpt, ${PTS.replace(/\b(k|hs|a|pl|df|rw|tk)\b/g, "m.$1")} pts,
        z.k, z.d, z.hs, z.a, z.pt, z.rw, z.rp, z.tk, z.pl, z.df
      FROM gstats m JOIN gplayers p ON p.sid=m.sid JOIN gstats z ON z.sid=m.sid AND z.period='all'
      WHERE m.period=? ORDER BY pts DESC, m.k DESC, p.last_seen DESC LIMIT ?`).all(period, limit);
    const wq = db.prepare("SELECT w, k FROM gweapons WHERE sid=? ORDER BY k DESC LIMIT 4");
    return rows.map(r => { const o = openSec(r.sid); return { sid: r.sid, n: r.name, last: r.last_seen, pts: r.pts, mk: r.mk, md: r.md, mhs: r.mhs, ma: r.ma, mpt: r.mpt + o,
      k: r.k, d: r.d, hs: r.hs, a: r.a, pt: r.pt + o, rw: r.rw, rp: r.rp, w: wq.all(r.sid).map(x => [x.w, x.k]) }; });
  }
  function player(sid) {
    const p = db.prepare("SELECT * FROM gplayers WHERE sid=?").get(sid); if (!p) return null;
    const z = db.prepare("SELECT * FROM gstats WHERE sid=? AND period='all'").get(sid) || {};
    const m = db.prepare(`SELECT *, ${PTS} pts FROM gstats WHERE sid=? AND period=?`).get(sid, month(Date.now())) || {};
    const o = openSec(sid);
    return { sid, n: p.name, last: p.last_seen, first: p.first_seen, pts: m.pts || 0, mk: m.k || 0, md: m.d || 0, mhs: m.hs || 0, ma: m.a || 0, mpt: (m.pt || 0) + o,
      k: z.k || 0, d: z.d || 0, hs: z.hs || 0, a: z.a || 0, pt: (z.pt || 0) + o, rw: z.rw || 0, rp: z.rp || 0,
      w: db.prepare("SELECT w, k FROM gweapons WHERE sid=? ORDER BY k DESC LIMIT 4").all(sid).map(x => [x.w, x.k]) };
  }
  // остановка/запуск сервера (из системного журнала): закрываем сессии, счёт на карте сбрасываем
  function serverStop(t) { closeAll(Math.max(S.lastT || t, Math.min(t, (S.lastT || t) + MAX_SESSION))); S.live.clear(); S.team.clear(); S.uid.clear(); S.nteam.clear(); resetMatch(); S.warm = false; S.lastT = Math.max(S.lastT, t); }
  // для окна сервера: сторона игрока по нику и счёт матча
  const teamOf = name => S.nteam.get(name) || "";
  const match = () => ({ ct: S.score.ct, t: S.score.t, warm: S.warm });
  const liveScore = name => { for (const x of S.live.values()) if (x.n === name) return { k: x.k, d: x.d }; return null; };
  // кто из игроков сейчас на сервере (по журналу): SteamID -> {uid, n}
  const online = () => S.uid;
  const sidByName = name => { let f = null; for (const [sid, x] of S.uid) if (x.n === name) { if (f) return null; f = sid; } return f; };
  return { apply, serverStop, top, player, liveScore, online, sidByName, teamOf, match, state: S, month };
}

module.exports = { parseLine, weaponName, makeStats, month, who };
