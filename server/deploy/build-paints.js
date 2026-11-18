"use strict";
// Собирает номера раскрасок CS2 для скинов сайта: node build-paints.js /var/lib/tasher/paints.json
// Источник — открытая база предметов CS2 (github.com/ByMykel/CSGO-API). Запускается при установке и обновлении.
const fs = require("node:fs");
const path = require("node:path");
const WP = require("../lib/wp");

const OUT = process.argv[2] || "/var/lib/tasher/paints.json";
const BASE = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/";
const W = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "wdata.json"), "utf8"));

async function get(name) {
  const r = await fetch(BASE + name, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(name + ": HTTP " + r.status);
  return r.json();
}

(async () => {
  let list = [];
  for (const f of ["skins.json", "skins_not_grouped.json"]) {
    try { const j = await get(f); list = list.concat(Array.isArray(j) ? j : Object.values(j)); console.log(f + ": " + (Array.isArray(j) ? j.length : Object.keys(j).length)); }
    catch (e) { console.log(f + ": не скачался (" + e.message + ")"); }
  }
  if (!list.length) { console.error("Не удалось скачать базу предметов. Старый файл раскрасок оставлен как есть."); process.exit(1); }

  const map = {};
  const add = (k, v) => { if (!(v > 0)) return; (map[k] = map[k] || []); if (!map[k].includes(v)) map[k].push(v); };
  for (const x of list) {
    const def = x && x.weapon && +x.weapon.weapon_id, pat = x && x.pattern && x.pattern.name, pi = +(x && x.paint_index);
    if (!def || !pat || !pi) continue;
    add(def + "|" + pat, pi);
    if (x.phase) add(def + "|" + pat + " " + x.phase, pi);
  }
  for (const k in map) map[k].sort((a, b) => a - b);

  // проверка: сколько скинов сайта нашли свою раскраску
  let all = 0, ok = 0; const miss = [];
  for (const w of W) {
    const def = WP.defOf(w.n); if (!def) continue;
    for (const sk of w.skins) {
      if (sk[0] === "Vanilla") continue;
      all++; if (map[def + "|" + sk[0]]) ok++; else miss.push(w.n + " | " + sk[0]);
    }
  }
  const noDef = W.filter(w => !WP.defOf(w.n) && w.c !== "agent").map(w => w.n);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(map)); fs.renameSync(OUT + ".tmp", OUT);
  console.log(`раскраски: найдено ${ok} из ${all} скинов сайта, записано в ${OUT}`);
  if (noDef.length) console.log("оружие без номера: " + noDef.join(", "));
  if (miss.length) console.log("без раскраски (" + miss.length + "): " + miss.slice(0, 25).join("; ") + (miss.length > 25 ? " …" : ""));
})().catch(e => { console.error(e); process.exit(1); });
