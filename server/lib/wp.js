"use strict";
// Связь инвентаря сайта с плагином WeaponPaints на игровом сервере.
// Надетые на сайте скины записываются в его базу MySQL/MariaDB (таблицы wp_player_skins, wp_player_knife, wp_player_gloves).
// Подключение — через консольный клиент mysql с файлом настроек (без сторонних библиотек).
const { execFile } = require("node:child_process");
const fs = require("node:fs");

// номера оружия в CS2 (defindex) и внутренние имена ножей
const DEF = {
  "Desert Eagle": 1, "Dual Berettas": 2, "Five-SeveN": 3, "Glock-18": 4, "AK-47": 7, "AUG": 8, "AWP": 9, "FAMAS": 10, "G3SG1": 11,
  "Galil AR": 13, "M249": 14, "M4A4": 16, "MAC-10": 17, "P90": 19, "MP5-SD": 23, "UMP-45": 24, "XM1014": 25, "PP-Bizon": 26, "MAG-7": 27,
  "Negev": 28, "Sawed-Off": 29, "Tec-9": 30, "Zeus x27": 31, "P2000": 32, "MP7": 33, "MP9": 34, "Nova": 35, "P250": 36, "SCAR-20": 38,
  "SG 553": 39, "SSG 08": 40, "M4A1-S": 60, "USP-S": 61, "CZ75-Auto": 63, "R8 Revolver": 64,
};
const KNIFE = {
  "Штык-нож": [500, "weapon_bayonet"], "Классический нож": [503, "weapon_knife_css"], "Складной нож": [505, "weapon_knife_flip"],
  "Нож с лезвием-крюком": [506, "weapon_knife_gut"], "Керамбит": [507, "weapon_knife_karambit"], "Штык-нож M9": [508, "weapon_knife_m9_bayonet"],
  "Охотничий нож": [509, "weapon_knife_tactical"], "Фальшион": [512, "weapon_knife_falchion"], "Нож Боуи": [514, "weapon_knife_survival_bowie"],
  "Нож-бабочка": [515, "weapon_knife_butterfly"], "Тычковые ножи": [516, "weapon_knife_push"], "Паракорд-нож": [517, "weapon_knife_cord"],
  "Нож выживания": [518, "weapon_knife_canis"], "Медвежий нож": [519, "weapon_knife_ursus"], "Наваха": [520, "weapon_knife_gypsy_jackknife"],
  "Нож «Бродяга»": [521, "weapon_knife_outdoor"], "Стилет": [522, "weapon_knife_stiletto"], "Коготь": [523, "weapon_knife_widowmaker"],
  "Скелетный нож": [525, "weapon_knife_skeleton"], "Нож кукри": [526, "weapon_knife_kukri"],
};
const GLOVES = {
  "Перчатки «Сломанный клык»": 4725, "Перчатки «Бладхаунд»": 5027, "Спортивные перчатки": 5030, "Водительские перчатки": 5031,
  "Обмотки рук": 5032, "Мотоциклетные перчатки": 5033, "Перчатки специалиста": 5034, "Перчатки «Гидра»": 5035,
};
const TEAM = { t: 2, ct: 3 };
const defOf = w => DEF[w] || (KNIFE[w] && KNIFE[w][0]) || GLOVES[w] || 0;

// агенты: название с сайта -> модель для WeaponPaints («tm_professional/tm_professional_varf5», без agents/models/ и .vmdl)
let AGENTS = {};
try { AGENTS = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "..", "data", "agents.json"), "utf8")); } catch (e) { AGENTS = {}; }
const AGENT_W = { "Агент CT": 3, "Агент T": 2 };

// номера раскрасок: файл собирается при установке (deploy/build-paints.js), ключ "defindex|название скина"
let PAINTS = {};
function loadPaints(file) {
  try { PAINTS = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { PAINTS = {}; }
  return Object.keys(PAINTS).length;
}
function paintOf(def, skin, seed) {
  if (!skin || skin === "Vanilla") return 0;
  const l = PAINTS[def + "|" + skin]; if (!l || !l.length) return null;
  return l[Math.abs(seed | 0) % l.length]; // у некоторых скинов несколько вариантов, выбираем по сиду предмета
}

// номера наклеек: файл собирается при установке вместе с раскрасками, ключ — английское название наклейки
let STICKERS = {};
function loadStickers(file) {
  try { STICKERS = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { STICKERS = {}; }
  return Object.keys(STICKERS).length;
}
// 5 слотов в формате WeaponPaints: "номер;схема;x;y;потёртость;масштаб;поворот"; пустой слот — "0;0;0;0;0;0;0"
const STK_EMPTY = "0;0;0;0;0;0;0";
function stickerCols(stk) {
  const out = [STK_EMPTY, STK_EMPTY, STK_EMPTY, STK_EMPTY, STK_EMPTY];
  if (!Array.isArray(stk)) return out;
  for (let i = 0; i < 5; i++) {
    const x = stk[i]; const id = x && STICKERS[x.n];
    if (!(id > 0)) continue;
    const wear = Math.min(1, Math.max(0, +x.wear || 0));
    out[i] = `${id | 0};0;0;0;${+wear.toFixed(3)};1;0`;
  }
  return out;
}

// строки для базы WeaponPaints по списку надетых предметов: [{team:"ct"|"t", it:{w,s,wear,seed,st,stk}}]
function rowsFor(loadout) {
  const skins = [], knife = [], gloves = [], miss = [], agents = {};
  for (const { team, it } of loadout) {
    const t = TEAM[team]; if (!t) continue;
    if (AGENT_W[it.w]) { if (AGENT_W[it.w] === t && AGENTS[it.s]) agents[t] = AGENTS[it.s]; continue; }
    const def = defOf(it.w); if (!def) continue;
    const paint = paintOf(def, it.s, it.seed);
    if (KNIFE[it.w]) knife.push({ t, cls: KNIFE[it.w][1] });
    if (paint == null) { miss.push(it.w + " | " + it.s); continue; }
    if (GLOVES[it.w]) { if (!paint) continue; gloves.push({ t, def }); }
    if (paint || !KNIFE[it.w]) skins.push({ t, def, paint, wear: Math.min(1, Math.max(0.000001, +it.wear || 0)), seed: Math.max(0, Math.min(1000, it.seed | 0)), st: it.st ? 1 : 0, stk: stickerCols(it.stk) });
  }
  return { skins, knife, gloves, miss, agents };
}

function sqlFor(steamid, rows) {
  if (!/^\d{17}$/.test(steamid)) throw new Error("bad steamid");
  const S = `'${steamid}'`, n = v => Number.isFinite(+v) ? String(+v) : "0", s = v => `'${String(v).replace(/[^a-z0-9_]/g, "")}'`;
  const q = ["START TRANSACTION;"];
  if (rows.skins.length) {
    q.push(`DELETE FROM wp_player_skins WHERE steamid=${S} AND (weapon_team,weapon_defindex) NOT IN (${rows.skins.map(r => `(${n(r.t)},${n(r.def)})`).join(",")});`);
    q.push(`INSERT INTO wp_player_skins (steamid,weapon_team,weapon_defindex,weapon_paint_id,weapon_wear,weapon_seed,weapon_stattrak) VALUES ${rows.skins.map(r => `(${S},${n(r.t)},${n(r.def)},${n(r.paint)},${n(r.wear)},${n(r.seed)},${n(r.st)})`).join(",")}` +
      ` ON DUPLICATE KEY UPDATE weapon_stattrak_count=IF(weapon_paint_id=VALUES(weapon_paint_id),weapon_stattrak_count,0),weapon_paint_id=VALUES(weapon_paint_id),weapon_wear=VALUES(weapon_wear),weapon_seed=VALUES(weapon_seed),weapon_stattrak=VALUES(weapon_stattrak);`);
  } else q.push(`DELETE FROM wp_player_skins WHERE steamid=${S};`);
  // наклейки: колонки weapon_sticker_0..4 есть в WeaponPaints последних версий; в старой базе их нет — тогда пропускаем
  for (const r of rows.skins) {
    if (!r.stk) continue;
    const set = r.stk.map((v, i) => `weapon_sticker_${i}='${String(v).replace(/[^0-9;.]/g, "")}'`).join(",");
    q.push(`SET @q = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_player_skins' AND COLUMN_NAME = 'weapon_sticker_4'), "UPDATE wp_player_skins SET ${set} WHERE steamid=${S} AND weapon_team=${n(r.t)} AND weapon_defindex=${n(r.def)}", 'DO 0');`);
    q.push("PREPARE wp_stk_q FROM @q; EXECUTE wp_stk_q; DEALLOCATE PREPARE wp_stk_q;");
  }
  q.push(`DELETE FROM wp_player_knife WHERE steamid=${S};`);
  if (rows.knife.length) q.push(`INSERT INTO wp_player_knife (steamid,weapon_team,knife) VALUES ${rows.knife.map(r => `(${S},${n(r.t)},${s(r.cls)})`).join(",")};`);
  q.push(`DELETE FROM wp_player_gloves WHERE steamid=${S};`);
  if (rows.gloves.length) q.push(`INSERT INTO wp_player_gloves (steamid,weapon_team,weapon_defindex) VALUES ${rows.gloves.map(r => `(${S},${n(r.t)},${n(r.def)})`).join(",")};`);
  // агенты: строка в wp_player_agents (NULL — стандартная модель); если таблицы нет (старый WeaponPaints) — пропускаем
  const ag = rows.agents || {}, am = v => v ? `'${String(v).replace(/[^a-z0-9_/]/g, "")}'` : "NULL";
  q.push(`SET @q = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_player_agents'), "INSERT INTO wp_player_agents (steamid,agent_ct,agent_t) VALUES (${S},${am(ag[3]).replace(/'/g, "\\'")},${am(ag[2]).replace(/'/g, "\\'")}) ON DUPLICATE KEY UPDATE agent_ct=VALUES(agent_ct),agent_t=VALUES(agent_t)", 'DO 0');`);
  q.push("PREPARE wp_ag_q FROM @q; EXECUTE wp_ag_q; DEALLOCATE PREPARE wp_ag_q;");
  q.push("COMMIT;");
  // просьба плагину применить скины сразу: WeaponPaints (форк mrc4tt) опрашивает таблицу wp_player_refresh,
  // обновляет скины игроку на сервере и удаляет строку. В исходной версии плагина таблицы нет — тогда ничего не делаем.
  q.push(`SET @q = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_player_refresh'), "INSERT INTO wp_player_refresh (steamid) VALUES ('${steamid}') ON DUPLICATE KEY UPDATE stamp = CURRENT_TIMESTAMP", 'DO 0');`);
  q.push("PREPARE wp_refresh_q FROM @q; EXECUTE wp_refresh_q; DEALLOCATE PREPARE wp_refresh_q;");
  return q.join("\n");
}

// очередь: записи одного игрока идут строго по порядку, частые нажатия склеиваются в одну запись
// onDone(steamid) вызывается после успешной записи — сайт просит игровой сервер сразу применить скины
function makeSync({ cnf, bin = "mysql", db = "weaponpaints", log = console, onDone = null }) {
  const pending = new Map(), running = new Set();
  function run(steamid, getLoadout) {
    running.add(steamid); pending.delete(steamid);
    let sql; try { sql = sqlFor(steamid, rowsFor(getLoadout())); } catch (e) { running.delete(steamid); log.error("[wp]", e.message); return; }
    const p = execFile(bin, [`--defaults-extra-file=${cnf}`, db], { timeout: 15000 }, (err, out, errOut) => {
      if (err) log.error("[wp] запись в базу скинов не прошла:", String(errOut || err.message).trim().slice(0, 300));
      else if (onDone) { try { onDone(steamid); } catch (e) {} }
      running.delete(steamid);
      if (pending.has(steamid)) run(steamid, pending.get(steamid));
    });
    p.stdin.on("error", () => {}); // ввод закрыт раньше времени — ошибку покажет сам mysql
    p.stdin.end(sql);
  }
  return function sync(steamid, getLoadout) {
    if (!cnf) return;
    pending.set(steamid, getLoadout);
    if (!running.has(steamid)) setTimeout(() => { if (!running.has(steamid) && pending.has(steamid)) run(steamid, pending.get(steamid)); }, 150);
  };
}

module.exports = { AGENTS, DEF, KNIFE, GLOVES, defOf, loadPaints, paintOf, loadStickers, stickerCols, rowsFor, sqlFor, makeSync };
