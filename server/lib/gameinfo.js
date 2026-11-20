"use strict";
// Данные для команд в игре (!rank, !top, !tk, !quests) и приветствия статусов — плагин TASHER Style читает их из базы.
// Сайт пишет две таблицы: tasher_player (кто сейчас на сервере и у кого есть статус) и tasher_top (топ-10 месяца).
const { execFile } = require("node:child_process");

const STEAM64 = 76561197960265728n;
const q = s => "'" + String(s == null ? "" : s).replace(/[\\']/g, "") + "'";
const int = v => (Number.isFinite(+v) ? Math.trunc(+v) : 0);
const name = s => String(s || "").replace(/[\u0000-\u001f]/g, "").slice(0, 64);
const okSid = sid => /^\d{17}$/.test(String(sid)) && BigInt(sid) > STEAM64;

// players: [{sid, n, tier, place, pts, k, d, hs, tk (null — нет на сайте), pending, earn:{base,cap,mult}, quests:{list,bonus,bonusTk}}]
// top: [{sid, n, pts, k, d}]
// sanctions: [{sid, mute:{until,reason}?, gag:{until,reason}?}] — мут и гег; null — плагин старый, таблицы tasher_punish нет
const untilSec = x => (x ? (x.until ? Math.floor(x.until / 1000) : 0) : -1); // -1 — нет, 0 — навсегда, иначе unix-секунды окончания
// opt.league — в tasher_player есть колонки лиги (league, sr, league_info), opt.pass — колонка боевого пропуска (pass)
function sqlFor(players, top, sanctions = null, opt = {}) {
  const out = ["START TRANSACTION;", "DELETE FROM tasher_player;", "DELETE FROM tasher_top;"];
  const rows = players.filter(p => okSid(p.sid));
  if (rows.length) out.push(`INSERT INTO tasher_player (steamid,name,tier,place,pts,kills,deaths,hs,tk,tk_pending,earn_today,earn_cap,earn_mult,quests${opt.league ? ",league,sr,league_info" : ""}${opt.pass ? ",pass" : ""}) VALUES ` +
    rows.map(p => {
      const qs = p.quests ? JSON.stringify({ l: p.quests.list.map(x => ({ n: x.n, h: x.have, g: x.goal, r: x.reward, d: x.done ? 1 : 0 })), b: p.quests.bonus ? 1 : 0, bt: p.quests.bonusTk }) : "";
      const lg = opt.league ? `,${q(p.league || "")},${int(p.sr)},${q(name(p.leagueInfo || "").slice(0, 120))}` : "";
      const ps = opt.pass ? `,${q(p.pass ? JSON.stringify(p.pass) : "")}` : "";
      return `(${p.sid},${q(name(p.n))},${q(p.tier || "")},${int(p.place)},${int(p.pts)},${int(p.k)},${int(p.d)},${int(p.hs)},${p.tk == null ? -1 : int(p.tk)},${int(p.pending)},${int(p.earn && p.earn.base)},${int(p.earn && p.earn.cap)},${q(p.earn ? String(p.earn.mult) : "1")},${q(qs)}${lg}${ps})`;
    }).join(",") + ";");
  const t = top.filter(p => okSid(p.sid)).slice(0, 10);
  if (t.length) out.push("INSERT INTO tasher_top (place,steamid,name,pts,kills,deaths) VALUES " +
    t.map((p, i) => `(${i + 1},${p.sid},${q(name(p.n))},${int(p.pts)},${int(p.k)},${int(p.d)})`).join(",") + ";");
  if (sanctions) {
    out.push("DELETE FROM tasher_punish;");
    const sx = sanctions.filter(x => okSid(x.sid) && (x.mute || x.gag));
    if (sx.length) out.push("INSERT INTO tasher_punish (steamid,mute_until,mute_reason,gag_until,gag_reason) VALUES " +
      sx.map(x => `(${x.sid},${untilSec(x.mute)},${q(x.mute ? name(x.mute.reason).slice(0, 100) : "")},${untilSec(x.gag)},${q(x.gag ? name(x.gag.reason).slice(0, 100) : "")})`).join(",") + ";");
  }
  out.push("COMMIT;");
  return out.join("\n");
}

function makeInfoSync({ cnf, bin = "mysql", db = "weaponpaints", collect, reload, log = console }) {
  let running = false, again = false, warned = false, lastSql = "";
  const run = (args, input) => new Promise((ok, no) => {
    const p = execFile(bin, [`--defaults-extra-file=${cnf}`, "--default-character-set=utf8mb4", "-N", "-B", db, ...args], { timeout: 15000, maxBuffer: 4 << 20 }, (err, out, e2) => err ? no(new Error(String(e2 || err.message).trim().slice(0, 300))) : ok(String(out)));
    p.stdin.on("error", () => {});
    if (input == null) p.stdin.end(); else p.stdin.end(input);
  });
  async function once(force) {
    const [has, pun, lgc, psc] = (await run(["-e", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('tasher_player','tasher_top'); SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_punish'; SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_player' AND COLUMN_NAME IN ('league','sr','league_info'); SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_player' AND COLUMN_NAME='pass'"])).trim().split(/\s+/);
    if (has !== "2") { if (!warned) { warned = true; log.log("[info] таблиц tasher_player/tasher_top ещё нет — нужен TASHER Style 1.2"); } return { skipped: true }; }
    warned = false;
    const { players, top, sanctions } = collect();
    const sql = sqlFor(players, top, pun === "1" ? sanctions || [] : null, { league: lgc === "3", pass: psc === "1" });
    if (sql === lastSql && !force) return { same: true };
    await run([], sql); lastSql = sql;
    try { await reload(); } catch (e) {}
    return { ok: true, players: players.length };
  }
  let forceNext = false;
  return async function sync(force = false) {
    if (!cnf) return null;
    if (force) forceNext = true;
    if (running) { again = true; return null; }
    running = true; let r = null;
    try { do { again = false; const f = forceNext; forceNext = false; r = await once(f); } while (again); }
    catch (e) { log.error("[info] запись для игры не прошла:", e.message); }
    finally { running = false; }
    return r;
  };
}

module.exports = { sqlFor, makeInfoSync };
