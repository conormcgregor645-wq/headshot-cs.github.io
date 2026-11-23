"use strict";
// Фортуна: один бесплатный приз в сутки (по Москве). Приз выбирает сервер.
// Призы и шансы — те же, что показаны на сайте (WR/WSEG в разметке).
const crypto = require("node:crypto");

const RARITY = [75, 20, 4, 1]; // обычный, редкий, легендарный, мифический (в процентах)
const SEGS = [
  [0, { tk: 300 }], [1, { tk: 3000 }], [0, { tk: 600 }], [2, { tk: 9000 }], [0, { tk: 900 }], [1, { rub: 25 }],
  [3, { tier: "LEGEND", d: 14 }], [0, { tk: 1200 }], [2, { rub: 50 }], [1, { tier: "VIP", d: 7 }], [3, { rub: 250 }], [2, { tier: "PREMIUM", d: 7 }],
];
const STREAK_BONUS = 6000; // за 7 дней подряд, ТК (ТК в Фортуне удвоены 23.11.2026)
const mskDay = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const rand = n => crypto.randomInt(n);

function pick() {
  let x = rand(10000) / 100, r = 0;
  for (; r < 3; r++) { if (x < RARITY[r]) break; x -= RARITY[r]; }
  const opts = SEGS.map((s, i) => [s, i]).filter(([s]) => s[0] === r);
  return { r, i: opts[rand(opts.length)][1] };
}
const prizeText = p => p.tk ? `${p.tk.toLocaleString("ru-RU")} ТК` : p.rub ? `${p.rub} ₽ на баланс` : `${p.tier} на ${p.d} дней`;

function makeWheel({ db, tx, addMoney, addGrant, statusOf, onStatus = () => {}, now = Date.now, pickFn = pick }) {
  const getRow = uid => db.prepare("SELECT * FROM wheel WHERE user_id=?").get(uid) || { last: "", streak: 0, again: 0, prize: null };
  function state(u, t = now()) {
    const w = getRow(u.id), day = mskDay(t);
    const againNow = w.last === day && !!w.again;
    return { canSpin: w.last !== day || againNow, again: againNow, streak: w.last === day || w.last === mskDay(t - 864e5) ? w.streak : 0, prize: w.prize, last: w.last };
  }
  function spin(u, t = now()) {
    return tx(() => {
      const w = getRow(u.id), day = mskDay(t), againNow = w.last === day && !!w.again;
      if (w.last === day && !againNow) { const e = new Error("Сегодня приз уже получен"); e.code = 409; throw e; }
      const { r, i } = pickFn(), p = SEGS[i][1];
      if (p.tk) addMoney(u.id, "tk", p.tk, "wheel", null, { what: "Фортуна: " + prizeText(p) });
      if (p.rub) addMoney(u.id, "rub", p.rub, "wheel", null, { what: "Фортуна: " + prizeText(p) });
      if (p.tier) addGrant(u.steamid, p.tier, p.d, "wheel", "Фортуна", "Фортуна");
      // серия входов считается по первой попытке дня
      let streak = w.streak, bonus = 0;
      if (!againNow) {
        streak = w.last === mskDay(t - 864e5) ? w.streak + 1 : 1;
        if (streak > 7) streak = 1;
        if (streak === 7) { bonus = STREAK_BONUS; addMoney(u.id, "tk", bonus, "wheel", null, { what: "Фортуна: 7 дней подряд" }); }
      }
      // обычный приз у владельца статуса выше VIP — ещё одна попытка (один раз в день)
      const st = statusOf(u.steamid), again = r === 0 && !!st && st !== "VIP" && !againNow;
      db.prepare("INSERT INTO wheel(user_id,last,streak,again,prize,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last=excluded.last, streak=excluded.streak, again=excluded.again, prize=excluded.prize, updated_at=excluded.updated_at")
        .run(u.id, day, streak, again ? 1 : 0, i, t);
      const me = db.prepare("SELECT tk, rub FROM users WHERE id=?").get(u.id);
      return { i, r, again, streak, bonus, prize: prizeText(p), tk: me.tk, balance: me.rub, tier: p.tier || null };
    });
  }
  return { state, spin, onStatus };
}

module.exports = { makeWheel, SEGS, RARITY, STREAK_BONUS, pick };
