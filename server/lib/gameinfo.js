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
function sqlFor(players, top) {
  const out = ["START TRANSACTION;", "DELETE FROM tasher_player;", "DELETE FROM tasher_top;"];
  const rows = players.filter(p => okSid(p.sid));
  if (rows.length) out.push("INSERT INTO tasher_player (steamid,name,tier,place,pts,kills,deaths,hs,tk,tk_pending,earn_today,earn_cap,earn_mult,quests) VALUES " +
    rows.map(p => {
      const qs = p.quests ? JSON.stringify({ l: p.quests.list.map(x => ({ n: x.n, h: x.have, g: x.goal, r: x.reward, d: x.done ? 1 : 0 })), b: p.quests.bonus ? 1 : 0, bt: p.quests.bonusTk }) : "";
      return `(${p.sid},${q(name(p.n))},${q(p.tier || "")},${int(p.place)},${int(p.pts)},${int(p.k)},${int(p.d)},${int(p.hs)},${p.tk == null ? -1 : int(p.tk)},${int(p.pending)},${int(p.earn && p.earn.base)},${int(p.earn && p.earn.cap)},${q(p.earn ? String(p.earn.mult) : "1")},${q(qs)})`;
    }).join(",") + ";");
  const t = top.filter(p => okSid(p.sid)).slice(0, 10);
  if (t.length) out.push("INSERT INTO tasher_top (place,steamid,name,pts,kills,deaths) VALUES " +
    t.map((p, i) => `(${i + 1},${p.sid},${q(name(p.n))},${int(p.pts)},${int(p.k)},${int(p.d)})`).join(",") + ";");
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
    const has = (await run(["-e", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('tasher_player','tasher_top')"])).trim();
    if (has !== "2") { if (!warned) { warned = true; log.log("[info] таблиц tasher_player/tasher_top ещё нет — нужен TASHER Style 1.2"); } return { skipped: true }; }
    warned = false;
    const { players, top } = collect();
    const sql = sqlFor(players, top);
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
