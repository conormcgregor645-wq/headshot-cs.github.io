"use strict";
// Статусы игроков -> VIP-плагин на игровом сервере (VIPCore, таблица vip_users в той же базе, что и скины).
// Сайт — единственный источник правды: в таблице всегда ровно те, у кого на сайте действует статус.
// После изменения игрокам на сервере статус применяется сразу командой css_reload_vip_player.
const { execFile } = require("node:child_process");

const STEAM64 = 76561197960265728n;
const GROUPS = new Set(["VIP", "PREMIUM", "ELITE", "LEGEND", "TITAN", "KING"]);
const accountId = sid => { const n = BigInt(sid) - STEAM64; return n > 0n && n < 4294967296n ? String(n) : null; };
// имя в таблице только для справки (плагин сам перепишет его при выходе игрока) — пишем латиницей, чтобы не зависеть от кодировки базы
const asciiName = s => String(s || "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 60) || "player";

// строки для vip_users: [{acc, sid, name, group, expires}]
function rowsFor(statuses) {
  const out = [];
  for (const s of statuses || []) {
    const acc = /^\d{17}$/.test(String(s.sid)) ? accountId(s.sid) : null;
    if (!acc || !GROUPS.has(s.t)) continue;
    out.push({ acc, sid: String(s.sid), name: s.n || "", group: s.t, expires: Math.floor(+s.u / 1000) });
  }
  return out;
}

function sqlFor(rows, serverId = 0) {
  const sid = Number.isInteger(serverId) ? serverId : 0;
  const q = ["START TRANSACTION;"];
  q.push(`DELETE FROM vip_users WHERE sid=${sid}${rows.length ? ` AND account_id NOT IN (${rows.map(r => r.acc).join(",")})` : ""};`);
  if (rows.length) q.push("INSERT INTO vip_users (account_id,name,lastvisit,sid,`group`,expires) VALUES " +
    rows.map(r => `(${r.acc},'${asciiName(r.name)}',UNIX_TIMESTAMP(),${sid},'${r.group}',${r.expires | 0 || 0})`).join(",") +
    " ON DUPLICATE KEY UPDATE `group`=VALUES(`group`), expires=VALUES(expires);");
  q.push("COMMIT;");
  return q.join("\n");
}

function makeVipSync({ cnf, bin = "mysql", db = "weaponpaints", serverId = 0, getStatuses, reload, log = console }) {
  let last = new Map(), running = false, again = false, warned = false;
  const run = (args, input) => new Promise((ok, no) => {
    const p = execFile(bin, [`--defaults-extra-file=${cnf}`, "-N", "-B", db, ...args], { timeout: 15000 }, (err, out, errOut) => err ? no(new Error(String(errOut || err.message).trim().slice(0, 300))) : ok(String(out)));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
  async function once() {
    const has = (await run(["-e", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='vip_users'"])).trim();
    if (has !== "1") { if (!warned) { warned = true; log.log("[vip] таблицы vip_users ещё нет — VIP-плагин на сервере не установлен"); } return { skipped: true }; }
    warned = false;
    const rows = rowsFor(getStatuses());
    await run([], sqlFor(rows, serverId));
    // кому статус изменился — применить в игре сразу (если игрока нет на сервере, команда ничего не делает)
    const now = new Map(rows.map(r => [r.sid, r.group + ":" + r.expires]));
    const changed = [...new Set([...now.keys(), ...last.keys()])].filter(k => now.get(k) !== last.get(k));
    last = now;
    for (const sid of changed) { try { await reload(sid); } catch (e) {} }
    return { rows: rows.length, changed };
  }
  // запуски не накладываются: если во время записи пришёл новый запрос — повторим после
  async function sync() {
    if (!cnf) return null;
    if (running) { again = true; return null; }
    running = true; let r = null;
    try { do { again = false; r = await once(); } while (again); }
    catch (e) { log.error("[vip] запись статусов в игру не прошла:", e.message); }
    finally { running = false; }
    return r;
  }
  return sync;
}

module.exports = { rowsFor, sqlFor, makeVipSync, accountId };
