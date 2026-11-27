"use strict";
// Стиль игрока в игре (плагин TASHER Style): тег и цвет ника в чате, тег в таблице счёта, цвет дыма,
// эффект и звук убийства, трассеры пуль и след гранат.
// Сайт собирает итог из статуса, клана и купленного оформления и пишет в таблицу tasher_style (та же база, что скины).
const { execFile } = require("node:child_process");

const TIER_COL = { VIP: "silver", PREMIUM: "lightblue", ELITE: "green", LEGEND: "purple", TITAN: "orange", KING: "gold" };
// цвета ника с сайта -> цвета чата CS2 (в чате только фиксированные цвета; градиенты — ближайшим)
const NICK_COL = { nk_0: "lime", nk_1: "lightblue", nk_2: "magenta", nk_3: "gold", nk_4: "lightpurple", nk_5: "red", nk_grad1: "grad-sunset", nk_grad2: "grad-toxic", nk_wops: "lightblue" };
// цвет клана -> цвет тега в чате
const CLAN_COL = { "#b5e853": "lime", "#ff8a3d": "orange", "#f5c451": "gold", "#3ddc97": "green", "#5aa9ff": "lightblue", "#a78bfa": "lightpurple", "#38d3ff": "lightblue", "#ff6b8b": "magenta", "#eb4b4b": "red" };
const hexRgb = h => { const m = /^#([0-9a-f]{6})$/i.exec(h || ""); if (!m) return ""; const n = parseInt(m[1], 16); return `${n >> 16},${(n >> 8) & 255},${n & 255}`; };
// цвет для плагина: #rrggbb -> "r,g,b"; легендарные переливающиеся передаются как есть ("anim:rainbow", дым — "random")
const ANIM = new Set(["rainbow", "neon", "flame", "aurora", "gold"]);
const fxColor = h => { const a = /^anim:([a-z]+)$/.exec(h || ""); return a && ANIM.has(a[1]) ? h : h === "random" ? "random" : hexRgb(h); };
// свой тег: буквы, цифры, пробел и простые знаки; фигурные скобки нельзя (это цвета чата)
const cleanTag = s => String(s || "").replace(/[^0-9A-Za-zА-Яа-яЁё _\-.!?*#]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
const STEAM64 = 76561197960265728n;

const KILL_FX = new Set(["spark", "bolt", "conf", "ring", "frost", "fire", "tornado", "star", "rainbow", "nova", "storm"]);
const KILL_SND = new Set(["ding", "drum", "bell", "8bit", "coin"]);
// звук MVP раунда (слышат все на сервере)
const MVP_SND = new Set(["csgo", "crimson", "sharpened", "highnoon", "iam", "diamonds", "moments", "disgusting", "wops"]);
// rows: [{sid, tier, clanTag, clanColor, nick (id), tag (свой тег), smokeHex, killFx, killSnd, trailHex, tracerHex, mvpSnd}]
function compose(r) {
  const parts = [];
  if (r.tier) parts.push(`{${TIER_COL[r.tier] || "default"}}[${r.tier}]`);
  const own = cleanTag(r.tag);
  if (own) parts.push(`{lime}[${own}]`);
  else if (r.clanTag) parts.push(`{${CLAN_COL[r.clanColor] || "olive"}}[${cleanTag(r.clanTag)}]`);
  if (!parts.length) parts.push("{grey}[Новенький]");
  const name = NICK_COL[r.nick] || (r.tier ? TIER_COL[r.tier] : "");
  // В Tab — только название привилегии. Очки месяца хранятся отдельно
  // в tasher_player.pts и никогда не добавляются в клановый тег.
  const score = TIER_COL[r.tier] ? r.tier : "";
  const smoke = r.smokeHex ? fxColor(r.smokeHex) : r.tier === "KING" ? "random" : "";
  const killFx = KILL_FX.has(r.killFx) ? r.killFx : "", killSnd = KILL_SND.has(r.killSnd) ? r.killSnd : "";
  return { chat: parts.join(" "), name, score: score.slice(0, 16), smoke, killFx, killSnd, trail: fxColor(r.trailHex), tracer: fxColor(r.tracerHex), mvpSnd: "", // звук MVP убран 25.11.2026
    model: /^[a-z0-9_]{1,16}$/.test(r.model || "") ? r.model : "", // своя модель игрока — ключ из конфига плагина (Models)
    wmodel: /^[a-z0-9_]{1,16}(,[a-z0-9_]{1,16}){0,3}$/.test(r.wmodel || "") ? r.wmodel : "" }; // свои модели оружия — ключи из WeaponModels через запятую (нож, пистолет, основное)
}
const q = s => "'" + String(s).replace(/[\\']/g, "") + "'";
// fx — сколько колонок эффектов есть в таблице (их добавляет плагин): 0 — нет, 4 — kill_fx..tracer (1.1), 5 — ещё mvp_snd (1.3), 6 — ещё model, 7 — ещё wmodel; true = 4
function sqlFor(rows, fx = 0) {
  const n = fx === true ? 4 : Number(fx) || 0;
  const ok = rows.filter(r => /^\d{17}$/.test(r.sid) && BigInt(r.sid) > STEAM64);
  const out = ["START TRANSACTION;", "DELETE FROM tasher_style;"];
  const cols = n >= 4 ? ",kill_fx,kill_snd,trail,tracer" + (n >= 5 ? ",mvp_snd" : "") + (n >= 6 ? ",model" : "") + (n >= 7 ? ",wmodel" : "") : "";
  if (ok.length) out.push(`INSERT INTO tasher_style (steamid,chat_tag,name_color,score_tag,smoke${cols}) VALUES ` +
    ok.map(r => { const c = compose(r); return `(${r.sid},${q(c.chat)},${q(c.name)},${q(c.score)},${q(c.smoke)}${n >= 4 ? `,${q(c.killFx)},${q(c.killSnd)},${q(c.trail)},${q(c.tracer)}` : ""}${n >= 5 ? `,${q(c.mvpSnd)}` : ""}${n >= 6 ? `,${q(c.model)}` : ""}${n >= 7 ? `,${q(c.wmodel)}` : ""})`; }).join(",") + ";");
  out.push("COMMIT;");
  return out.join("\n");
}

function makeStyleSync({ cnf, bin = "mysql", db = "weaponpaints", collect, reload, log = console }) {
  let running = false, again = false, warned = false, lastSql = "";
  const run = (args, input) => new Promise((ok, no) => {
    const p = execFile(bin, [`--defaults-extra-file=${cnf}`, "--default-character-set=utf8mb4", "-N", "-B", db, ...args], { timeout: 15000 }, (err, out, e2) => err ? no(new Error(String(e2 || err.message).trim().slice(0, 300))) : ok(String(out)));
    // mysql может закрыть ввод раньше, чем мы допишем (например, с -e) — это не ошибка
    p.stdin.on("error", () => {});
    if (input == null) p.stdin.end(); else p.stdin.end(input);
  });
  async function once() {
    const [has, cols] = (await run(["-e", "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_style'; SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasher_style' AND COLUMN_NAME IN ('kill_fx','kill_snd','trail','tracer','mvp_snd','model','wmodel')"])).trim().split(/\s+/);
    if (has !== "1") { if (!warned) { warned = true; log.log("[style] таблицы tasher_style ещё нет — плагин TASHER Style не установлен"); } return { skipped: true }; }
    warned = false;
    const sql = sqlFor(collect(), Number(cols) || 0);
    if (sql === lastSql) return { same: true };
    await run([], sql); lastSql = sql;
    try { await reload(); } catch (e) {}
    return { ok: true };
  }
  return async function sync() {
    if (!cnf) return null;
    if (running) { again = true; return null; }
    running = true; let r = null;
    try { do { again = false; r = await once(); } while (again); }
    catch (e) { log.error("[style] запись в игру не прошла:", e.message); }
    finally { running = false; }
    return r;
  };
}

module.exports = { compose, sqlFor, makeStyleSync, cleanTag, NICK_COL, KILL_FX, KILL_SND, MVP_SND };
