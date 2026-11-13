"use strict";
// Игровая логика: цены скинов, качество, выпадение из кейсов, апгрейд.
// Формулы перенесены с сайта один в один, но случайные числа берутся из crypto.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA = path.join(__dirname, "..", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "wdata.json"), "utf8"));
const CASES = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf8"));
const CASE_BY_K = new Map(CASES.map(c => [c.k, c]));
const W_BY_N = new Map(W.map(w => [w.n, w]));

// равномерное число [0,1) из криптостойкого генератора
function rnd() { return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48; }

const WBR = [[0, .07], [.07, .15], [.15, .38], [.38, .45], [.45, 1]];
const wIdx = f => f < .07 ? 0 : f < .15 ? 1 : f < .38 ? 2 : f < .45 ? 3 : 4;
const hasSt = sk => !!(sk[10] && sk[10].some(x => x));
const skArr = (sk, st) => st === "sv" ? (sk[12] || []) : (st && hasSt(sk)) ? sk[10] : sk[9] || [];

function skPrice(w, sk, wear, st) {
  const a = skArr(sk, st); const i = wIdx(wear); let v = null;
  for (let d = 0; d < 5 && v == null; d++) v = a[i - d] ?? a[i + d] ?? null;
  if (v == null) return 0;
  return Math.round(v * (st === true && !hasSt(sk) ? 1.4 : 1));
}
function wearOpts(sk, st) {
  const lo = sk[7] || 0, hi = sk[8] == null ? 1 : (sk[8] || 1), a = skArr(sk, st); const l = [];
  WBR.forEach(([a0, a1], i) => { if (a1 > lo && a0 < hi) l.push(i); });
  const p = l.filter(i => a[i]); return p.length ? p : l.length ? l : [2];
}
function wearRange(sk, i) {
  const lo = Math.max(sk[7] || 0, WBR[i][0]), hi = Math.min(sk[8] == null ? 1 : (sk[8] || 1), WBR[i][1]);
  return hi > lo ? [lo, hi] : WBR[i];
}
const SP = {
  bg: { n: "Blue Gem", ok: (w, sk) => sk[0] === "Case Hardened", m: w => w.c === "knife" ? 10 : (w.n === "AK-47" || w.n === "Five-SeveN") ? 8 : 4 },
  f100: { n: "Fade 100%", ok: (w, sk) => sk[0] === "Fade", m: () => 1.6 },
};
const spList = (w, sk) => Object.keys(SP).filter(k => SP[k].ok(w, sk));
function spWear(sk, i) { const [lo, hi] = wearRange(sk, i); return Math.floor((lo + rnd() * (hi - lo)) * 1000) / 1000; }
function rollWear(sk, st) {
  const l = wearOpts(sk, st), i = l[Math.floor(rnd() * l.length)], [lo, hi] = wearRange(sk, i);
  return Math.floor((lo + rnd() * (hi - lo)) * 1000) / 1000;
}
function findSkin(wn, sn) { const w = W_BY_N.get(wn); const sk = w && w.skins.find(x => x[0] === sn); return w && sk ? { w, sk } : null; }

// стоимость предмета (как itVal на сайте)
function itemValue(it) {
  if (it.fx) return it.fx;
  const f = findSkin(it.w, it.s); if (!f) return 0;
  const st = it.sv ? "sv" : !!it.st;
  return Math.round(skPrice(f.w, f.sk, it.wear, st) * (it.sp && SP[it.sp] ? SP[it.sp].m(f.w) : 1));
}

function newId() { return crypto.randomBytes(9).toString("base64url"); }

function mkDrop(src, stForce) {
  const f = findSkin(src[0], src[1]); if (!f) throw new Error("skin not found " + src[0] + " | " + src[1]);
  const { w, sk } = f;
  if (src[6]) return { id: newId(), w: src[0], s: src[1], r: src[2], wear: 0, st: false, sv: false, sp: null, fx: src[6], seed: crypto.randomInt(0, 1000) };
  const st = stForce != null ? stForce : (w.c !== "gloves" && w.c !== "agent" && rnd() < .1);
  const d = { id: newId(), w: src[0], s: src[1], r: src[2], wear: rollWear(sk, st), st: !!st, sv: false, sp: null, fx: 0, seed: crypto.randomInt(0, 1000) };
  if (rnd() < .005) {
    const wi = wIdx(d.wear), l = spList(w, sk);
    if (l.length) { d.sp = l[Math.floor(rnd() * l.length)]; d.wear = spWear(sk, wi); }
  }
  return d;
}

function rollCase(c) {
  let it;
  if (c.wt) {
    let x = rnd() * c.wt.reduce((a, b) => a + b, 0), q = 0;
    for (; q < c.wt.length - 1; q++) { if (x < c.wt[q]) break; x -= c.wt[q]; }
    it = c.items[q];
    return mkDrop(it, it.length > 5 && !it[6] ? !!it[5] : null);
  }
  const x = rnd() * 100, sp = (c.knife || 0) + (c.gloves || 0);
  if (x < sp) {
    const kind = x < (c.knife || 0) ? "knife" : "gloves"; const l = c.items.filter(i => i[3] === kind);
    it = l[Math.floor(rnd() * l.length)];
  } else {
    let y = rnd() * 100, r = 0; for (; r < 4; r++) { if (y < c.odds[r]) break; y -= c.odds[r]; }
    const base = c.items.filter(i => !i[3] || c.pool === i[3]);
    for (let d = 0; d < 5 && !it; d++) for (const rr of [r - d, r + d]) {
      const l = base.filter(i => i[2] === rr); if (l.length) { it = l[Math.floor(rnd() * l.length)]; break; }
    }
  }
  return mkDrop(it);
}

// цели апгрейда: ключ "Оружие|Скин|качество|0/1/2[|sp]" (0 обычный, 1 StatTrak, 2 сувенир)
const UP_EDGE = .9, UP_MAX = 75;
function upTarget(key) {
  if (typeof key !== "string" || key.length > 200) return null;
  const [wn, sn, iS, vS, sp] = key.split("|"); const i = +iS, v = +vS;
  if (!(i >= 0 && i <= 4) || ![0, 1, 2].includes(v)) return null;
  const f = findSkin(wn, sn); if (!f) return null;
  const { w, sk } = f;
  if (w.c === "item" || w.c === "agent") return null;
  if (v && w.c === "gloves") return null;
  const st = v === 2 ? "sv" : v === 1;
  const a = st === "sv" ? (sk[12] || []) : (st ? sk[10] : sk[9]) || [];
  if (!a[i]) return null;
  if (!wearOpts(sk, st).includes(i)) return null;
  let p = a[i];
  if (sp) { if (!SP[sp] || !spList(w, sk).includes(sp) || sk[0] === "Vanilla") return null; p = Math.round(a[i] * SP[sp].m(w)); }
  return { w, sk, i, st: v === 1, sv: v === 2, sp: sp || null, p };
}
function upChance(stake, price) { return Math.min(UP_MAX, stake / price * UP_EDGE * 100); }
function upItem(t) {
  return { id: newId(), w: t.w.n, s: t.sk[0], r: t.sk[5], wear: spWear(t.sk, t.i), st: t.st, sv: t.sv, sp: t.sp, fx: 0, seed: crypto.randomInt(0, 1000) };
}

module.exports = { W, CASES, CASE_BY_K, rnd, rollCase, itemValue, upTarget, upChance, upItem, findSkin, UP_MAX };
