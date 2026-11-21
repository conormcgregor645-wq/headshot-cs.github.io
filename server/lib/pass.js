"use strict";
// Боевой пропуск: сезон, 50 уровней по 2000 опыта. Опыт — за игру на сервере (по журналу), выигранные раунды и задания дня.
// Две ветки наград: бесплатная и премиум (покупается за рубли с баланса, открывает премиум-награды всех уровней, в том числе уже пройденных).
// Награды забираются кнопкой на сайте до конца сезона.

const LEVELS = 50, XP_LEVEL = 2000, DAY_CAP = 1500, PREMIUM_PRICE = 349;
// опыт за игру (до множителя события «Выходные опыта»), в сутки по Москве не больше DAY_CAP
const XP = { kill: 10, killBot: 2, hs: 3, assist: 5, plant: 10, defuse: 15, roundWin: 10, minute: 5 };
// за задания дня — без суточного лимита
const XP_QUEST = { easy: 150, medium: 300, hard: 500, all: 300 };
const MSK = 3 * 3600e3;
const SEASONS = [
  { id: "s1", n: "Сезон 1 · Зима", from: Date.UTC(2026, 10, 19, 21), to: Date.UTC(2027, 0, 31, 21) }, // 20.11.2026 00:00 — 01.02.2027 00:00 МСК
];
const mskDay = t => new Date(t + MSK).toISOString().slice(0, 10);

// награды по уровням: t — tk | case | cos | status
function rewards() {
  const free = [], prem = [];
  // UPD: между ключевыми уровнями — разные предметы и кейсы вместо одних только ТК.
  // Все ID — из server/data/cosmetics.json. Уже полученные покупки конвертируются в ТК через give().
  const freeExtra = {
    3: { t: "cos", id: "bd_skull" },
    7: { t: "case", k: "army" },
    12: { t: "cos", id: "bd_bolt" },
    18: { t: "cos", id: "bg_i_nydust" },
    23: { t: "cos", id: "sd_ding" },
    28: { t: "case", k: "army" },
    33: { t: "cos", id: "tr_1" },
    38: { t: "cos", id: "bd_wolf" },
    43: { t: "cos", id: "fr_ice" },
    48: { t: "case", k: "fire" },
  };
  const premExtra = {
    3: { t: "cos", id: "bd_fire" },
    8: { t: "cos", id: "fr_emer" },
    12: { t: "cos", id: "sd_8bit" },
    18: { t: "cos", id: "tr_4" },
    22: { t: "case", k: "fire" },
    28: { t: "cos", id: "kl_conf" },
    33: { t: "cos", id: "sm_2" },
    38: { t: "cos", id: "tc_2" },
    43: { t: "cos", id: "bg_i_nyfire" },
    48: { t: "cos", id: "fr_plasma" },
  };
  for (let lv = 1; lv <= LEVELS; lv++) {
    const f = { 5: { t: "case", k: "army" }, 10: { t: "cos", id: "bd_aim" }, 15: { t: "case", k: "army" }, 20: { t: "cos", id: "tc_0" }, 25: { t: "status", tier: "VIP", d: 3 },
      30: { t: "cos", id: "kl_spark" }, 35: { t: "case", k: "army" }, 40: { t: "cos", id: "fr_lime" }, 45: { t: "case", k: "army" }, 50: { t: "status", tier: "PREMIUM", d: 7 } }[lv];
    free.push([f || freeExtra[lv] || { t: "tk", v: 100 + 10 * lv }]);
    const p = { 5: [{ t: "case", k: "fire" }], 10: [{ t: "cos", id: "nk_grad1" }], 15: [{ t: "status", tier: "ELITE", d: 7 }], 20: [{ t: "cos", id: "kl_bolt" }],
      25: [{ t: "case", k: "knife" }], 30: [{ t: "cos", id: "tc_3" }], 35: [{ t: "status", tier: "LEGEND", d: 7 }], 40: [{ t: "cos", id: "sm_4" }], 45: [{ t: "case", k: "knife" }],
      50: [{ t: "status", tier: "KING", d: 14 }, { t: "cos", id: "fr_winter" }] }[lv];
    prem.push(p || [premExtra[lv] || { t: "tk", v: 200 + 20 * lv }]);
  }
  return { free, prem };
}
const REWARDS = rewards();

function makePass({ db, tx, addMoney, giveItem, rollCase, caseByK, cosById, addGrant, onGrant = () => {}, eventMult = () => 1, now = Date.now, log = console }) {
  const season = (t = now()) => SEASONS.find(s => s.from <= t && t < s.to) || null;
  const nextSeason = (t = now()) => SEASONS.filter(s => s.from > t).sort((a, b) => a.from - b.from)[0] || null;
  const getQ = db.prepare("SELECT * FROM pass WHERE sid=? AND season=?");
  const row = (sid, s) => getQ.get(sid, s) || { sid, season: s, xp: 0, prem: 0, claimed: "", day: "", day_xp: 0 };
  const save = r => db.prepare(`INSERT INTO pass(sid,season,xp,prem,claimed,day,day_xp,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(sid,season) DO UPDATE SET xp=excluded.xp, prem=excluded.prem, claimed=excluded.claimed, day=excluded.day, day_xp=excluded.day_xp, updated_at=excluded.updated_at`)
    .run(r.sid, r.season, r.xp, r.prem, r.claimed, r.day, r.day_xp, now());
  const levelOf = xp => Math.min(LEVELS, Math.floor(xp / XP_LEVEL));

  // начислить опыт; game — опыт за игру (с суточным лимитом), иначе за задания
  function addXp(sid, base, t = now(), game = true) {
    const s = season(t); if (!s || !sid || !(base > 0)) return 0;
    const r = row(sid, s.id), day = mskDay(t);
    if (r.day !== day) { r.day = day; r.day_xp = 0; }
    let b = base;
    if (game) { b = Math.min(b, DAY_CAP - r.day_xp); if (b <= 0) return 0; r.day_xp += b; }
    const gain = Math.round(b * eventMult(t));
    const before = levelOf(r.xp);
    r.xp = Math.min(LEVELS * XP_LEVEL, r.xp + gain); save(r);
    const after = levelOf(r.xp);
    if (after > before) log.log(`[pass] ${sid}: уровень ${after}`);
    return gain;
  }
  function apply(ev, warm) {
    if (!ev || warm) return;
    const t = ev.t || now(), human = p => p && p.sid && !p.bot;
    switch (ev.e) {
      case "kill":
        if (human(ev.a) && ev.v && ev.a.sid !== ev.v.sid && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team))
          addXp(ev.a.sid, (ev.v.bot ? XP.killBot : XP.kill) + (ev.hs && !ev.v.bot ? XP.hs : 0), t);
        break;
      case "assist": if (human(ev.a) && ev.v && !ev.v.bot && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team)) addXp(ev.a.sid, XP.assist, t); break;
      case "plant": if (human(ev.a)) addXp(ev.a.sid, XP.plant, t); break;
      case "defuse": if (human(ev.a)) addXp(ev.a.sid, XP.defuse, t); break;
    }
  }
  const roundWin = (sids, t = now()) => { for (const s of sids) addXp(s, XP.roundWin, t); };
  const minute = (sids, t = now()) => { for (const s of sids) addXp(s, XP.minute, t); };
  // задание дня выполнено: lv — easy / medium / hard, «all» — все три
  const quest = (sid, lv, t = now()) => addXp(sid, XP_QUEST[lv] || 0, t, false);

  const claimedSet = r => new Set(String(r.claimed || "").split(",").filter(Boolean));
  function state(sid, t = now()) {
    const s = season(t);
    const base = { levels: LEVELS, xpLevel: XP_LEVEL, price: PREMIUM_PRICE, dayCap: DAY_CAP, xp: XP, xpQuest: XP_QUEST, rewards: REWARDS };
    if (!s) { const n = nextSeason(t); return { ...base, season: null, next: n ? { n: n.n, from: n.from } : null }; }
    const r = sid ? row(sid, s.id) : null, lv = r ? levelOf(r.xp) : 0;
    return { ...base, season: { id: s.id, n: s.n, from: s.from, to: s.to },
      me: r ? { xp: r.xp, lv, into: r.xp - lv * XP_LEVEL, prem: !!r.prem, claimed: [...claimedSet(r)], today: r.day === mskDay(t) ? r.day_xp : 0, unclaimed: unclaimedOf(r, lv) } : null };
  }
  function unclaimedOf(r, lv) {
    const c = claimedSet(r); let n = 0;
    for (let i = 1; i <= lv; i++) { if (!c.has("f" + i)) n++; if (r.prem && !c.has("p" + i)) n++; }
    return n;
  }

  // выдать одну награду (внутри транзакции); возвращает текст
  function give(u, rw, lv) {
    const note = `Боевой пропуск, уровень ${lv}`;
    switch (rw.t) {
      case "tk": addMoney(u.id, "tk", rw.v, "pass", "lv" + lv, { what: `${note}: ${rw.v} ТК` }); return `${rw.v} ТК`;
      case "case": {
        const c = caseByK(rw.k); if (!c) { addMoney(u.id, "tk", 500, "pass", "lv" + lv, { what: `${note}: 500 ТК` }); return "500 ТК"; }
        const it = giveItem(u.id, rollCase(c), "pass", "lv" + lv); return `${it.w} | ${it.s} (кейс «${c.n}»)`;
      }
      case "cos": {
        const it = cosById(rw.id);
        if (!it) return "";
        if (db.prepare("SELECT 1 FROM cos_own WHERE user_id=? AND item_id=?").get(u.id, it.id)) {
          const v = it.p * 10; addMoney(u.id, "tk", v, "pass", "lv" + lv, { what: `${note}: «${it.n}» уже было — ${v} ТК` }); return `${v} ТК вместо «${it.n}» (уже было)`;
        }
        db.prepare("INSERT INTO cos_own(user_id,item_id,created_at) VALUES(?,?,?)").run(u.id, it.id, now()); return `«${it.n}»`;
      }
      case "status": addGrant(u.steamid, rw.tier, rw.d, "pass", note, "Боевой пропуск"); return `${rw.tier} на ${rw.d} дн.`;
    }
    return "";
  }
  // забрать награды: track f|p и уровень, или all — всё доступное
  function claim(u, body) {
    const s = season(); if (!s) throw Object.assign(new Error("Сезон закончился"), { code: 409 });
    const got = [];
    let status = false;
    tx(() => {
      const r = row(u.steamid, s.id), lv = levelOf(r.xp), c = claimedSet(r);
      const want = [];
      if (body.all) { for (let i = 1; i <= lv; i++) { want.push(["f", i]); if (r.prem) want.push(["p", i]); } }
      else {
        const tr = body.track === "p" ? "p" : body.track === "f" ? "f" : null, l = Number(body.lv);
        if (!tr || !Number.isInteger(l) || l < 1 || l > LEVELS) throw Object.assign(new Error("Неверная награда"), { code: 400 });
        if (l > lv) throw Object.assign(new Error(`Нужен уровень ${l}`), { code: 409 });
        if (tr === "p" && !r.prem) throw Object.assign(new Error("Это награда премиум-пропуска"), { code: 409 });
        if (c.has(tr + l)) throw Object.assign(new Error("Уже получено"), { code: 409 });
        want.push([tr, l]);
      }
      for (const [tr, l] of want) {
        if (c.has(tr + l)) continue;
        for (const rw of (tr === "f" ? REWARDS.free : REWARDS.prem)[l - 1]) { const txt = give(u, rw, l); if (txt) got.push({ lv: l, track: tr, txt }); if (rw.t === "status") status = true; }
        c.add(tr + l);
      }
      r.claimed = [...c].join(","); save(r);
    });
    if (status) onGrant();
    return { got, status };
  }
  function buyPremium(u) {
    const s = season(); if (!s) throw Object.assign(new Error("Сезон закончился"), { code: 409 });
    return tx(() => {
      const r = row(u.steamid, s.id); if (r.prem) throw Object.assign(new Error("Премиум уже куплен"), { code: 409 });
      const balance = addMoney(u.id, "rub", -PREMIUM_PRICE, "shop", "pass:" + s.id, { what: `Премиум-пропуск: ${s.n}` });
      r.prem = 1; save(r);
      log.log(`[pass] ${u.name || u.id} купил премиум (${s.id})`);
      return { balance };
    });
  }
  // для команды !pass в игре
  function brief(sid, t = now()) {
    const s = season(t); if (!s) return null;
    const r = getQ.get(sid, s.id); const xp = r ? r.xp : 0, lv = levelOf(xp);
    return { s: s.n, lv, xp: lv >= LEVELS ? XP_LEVEL : xp - lv * XP_LEVEL, need: XP_LEVEL, max: LEVELS, prem: r && r.prem ? 1 : 0, un: r ? unclaimedOf(r, lv) : 0, to: Math.floor(s.to / 1000) };
  }
  return { apply, roundWin, minute, quest, addXp, state, claim, buyPremium, brief, season };
}

module.exports = { makePass, REWARDS, LEVELS, XP_LEVEL, DAY_CAP, PREMIUM_PRICE, SEASONS, XP, XP_QUEST };
