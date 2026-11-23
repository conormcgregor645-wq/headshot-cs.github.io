"use strict";
// Ежедневные задания: каждый день (по Москве) три задания — лёгкое, среднее и сложное, одинаковые для всех.
// Еженедельные: каждую неделю (с понедельника по Москве) пять заданий посложнее, награды 1 000–5 000 ТК.
// Прогресс считается по журналу CS2 (как ТК за игру), награда в ТК приходит сама, как только задание выполнено.
// За все три задания дня — бонус. Разминка, тимкиллы и самоубийства не считаются.

const PISTOLS = ["glock", "hkp2000", "usp_silencer", "usp_silencer_off", "p250", "fiveseven", "tec9", "cz75a", "deagle", "elite", "revolver"];
const SMGS = ["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"];
const M4 = ["m4a1", "m4a1_silencer", "m4a1_silencer_off"];
const NADES = ["hegrenade", "inferno", "molotov", "incgrenade"];
const isKnife = w => /^(knife|bayonet)/.test(String(w || ""));

// c — что считаем: kill (w — оружие, knife — нож, hs — только в голову), assist, plant, defuse, roundWin, minute
const POOL = {
  easy: [
    { id: "k15", n: "Убей 15 противников", c: "kill", goal: 15 },
    { id: "hs5", n: "Сделай 5 убийств в голову", c: "kill", hs: true, goal: 5 },
    { id: "as5", n: "Сделай 5 помощей в убийстве", c: "assist", goal: 5 },
    { id: "rw8", n: "Выиграй 8 раундов", c: "roundWin", goal: 8 },
    { id: "pt30", n: "Отыграй на сервере 30 минут", c: "minute", goal: 30 },
    { id: "pl2", n: "Заложи бомбу 2 раза", c: "plant", goal: 2 },
  ],
  medium: [
    { id: "ak15", n: "Убей 15 противников с AK-47", c: "kill", w: ["ak47"], goal: 15 },
    { id: "m412", n: "Убей 12 противников с M4A4 или M4A1-S", c: "kill", w: M4, goal: 12 },
    { id: "pis8", n: "Убей 8 противников из пистолета", c: "kill", w: PISTOLS, goal: 8 },
    { id: "smg10", n: "Убей 10 противников из пистолета-пулемёта", c: "kill", w: SMGS, goal: 10 },
    { id: "hs15", n: "Сделай 15 убийств в голову", c: "kill", hs: true, goal: 15 },
    { id: "k40", n: "Убей 40 противников", c: "kill", goal: 40 },
    { id: "rw15", n: "Выиграй 15 раундов", c: "roundWin", goal: 15 },
    { id: "df2", n: "Разминируй бомбу 2 раза", c: "defuse", goal: 2 },
  ],
  hard: [
    { id: "awp15", n: "Убей 15 противников с AWP", c: "kill", w: ["awp"], goal: 15 },
    { id: "knife1", n: "Убей противника ножом", c: "kill", knife: true, goal: 1 },
    { id: "hs30", n: "Сделай 30 убийств в голову", c: "kill", hs: true, goal: 30 },
    { id: "k80", n: "Убей 80 противников", c: "kill", goal: 80 },
    { id: "pt120", n: "Отыграй на сервере 2 часа", c: "minute", goal: 120 },
    { id: "nade3", n: "Убей 3 противников гранатой или молотовым", c: "kill", w: NADES, goal: 3 },
    { id: "zeus2", n: "Убей 2 противников из Zeus", c: "kill", w: ["taser"], goal: 2 },
  ],
};
const LEVELS = ["easy", "medium", "hard"];
const REWARD = { easy: 150, medium: 300, hard: 600 };
const ALL_BONUS = 300;
const LEVEL_RU = { easy: "Лёгкое", medium: "Среднее", hard: "Сложное" };

// еженедельные: 5 ступеней, на каждой — своё задание недели из небольшого набора
const WEEK = [
  { reward: 1000, pool: [
    { id: "wk150", n: "Убей 150 противников", c: "kill", goal: 150 },
    { id: "wrw60", n: "Выиграй 60 раундов", c: "roundWin", goal: 60 },
    { id: "wpt300", n: "Отыграй на сервере 5 часов", c: "minute", goal: 300 } ] },
  { reward: 1500, pool: [
    { id: "whs75", n: "Сделай 75 убийств в голову", c: "kill", hs: true, goal: 75 },
    { id: "was40", n: "Сделай 40 помощей в убийстве", c: "assist", goal: 40 },
    { id: "wpl10", n: "Заложи бомбу 10 раз", c: "plant", goal: 10 } ] },
  { reward: 2500, pool: [
    { id: "wak100", n: "Убей 100 противников с AK-47", c: "kill", w: ["ak47"], goal: 100 },
    { id: "wm480", n: "Убей 80 противников с M4A4 или M4A1-S", c: "kill", w: M4, goal: 80 },
    { id: "wpis60", n: "Убей 60 противников из пистолета", c: "kill", w: PISTOLS, goal: 60 },
    { id: "wsmg60", n: "Убей 60 противников из пистолета-пулемёта", c: "kill", w: SMGS, goal: 60 } ] },
  { reward: 3500, pool: [
    { id: "wawp50", n: "Убей 50 противников с AWP", c: "kill", w: ["awp"], goal: 50 },
    { id: "wdf10", n: "Разминируй бомбу 10 раз", c: "defuse", goal: 10 },
    { id: "wnade15", n: "Убей 15 противников гранатой или молотовым", c: "kill", w: NADES, goal: 15 },
    { id: "wk400", n: "Убей 400 противников", c: "kill", goal: 400 } ] },
  { reward: 5000, pool: [
    { id: "wknife5", n: "Убей 5 противников ножом", c: "kill", knife: true, goal: 5 },
    { id: "wzeus8", n: "Убей 8 противников из Zeus", c: "kill", w: ["taser"], goal: 8 },
    { id: "whs250", n: "Сделай 250 убийств в голову", c: "kill", hs: true, goal: 250 },
    { id: "wpt900", n: "Отыграй на сервере 15 часов", c: "minute", goal: 900 } ] },
];
const WEEK_RU = ["I", "II", "III", "IV", "V"];

const mskDay = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
// неделя по Москве: ключ — понедельник ("W2026-11-23"), конец — следующий понедельник 00:00 МСК
function weekOf(t) {
  const d = new Date(mskDay(t) + "T00:00:00Z"), wd = (d.getUTCDay() + 6) % 7; // 0 — понедельник
  const mon = d.getTime() - wd * 86400e3;
  return { key: "W" + new Date(mon).toISOString().slice(0, 10), n: Math.round(mon / (7 * 86400e3)), ends: mon - 3 * 3600e3 + 7 * 86400e3 };
}
// задания недели: на каждой ступени — по кругу из её набора (соседние недели не повторяются)
function forWeek(t) {
  const w = weekOf(t);
  return WEEK.map((st, i) => { const n = st.pool.length, k = perm(n, "w" + i + Math.floor(w.n / n))[w.n % n]; return { ...st.pool[k], lv: "week", step: i, reward: st.reward }; });
}
// конец дня по Москве (для таймера «новые задания через …»)
const dayEnd = t => { const d = new Date(mskDay(t) + "T00:00:00Z").getTime() - 3 * 3600e3; return d + 86400e3; };
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
// перестановка индексов 0..n-1 для «цикла» дней (детерминированно по зерну)
function perm(n, seed) {
  const a = [...Array(n).keys()]; let h = hash("p" + seed);
  for (let i = n - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// индекс задания сложности lv на день dn (номер дня): по циклам, внутри цикла все задания по разу;
// на стыке циклов первое задание не совпадает с последним предыдущего — два дня подряд одно и то же не выпадает
function pickIdx(lv, dn) {
  const n = POOL[lv].length, cyc = Math.floor(dn / n), pos = dn % n;
  const cur = perm(n, lv + cyc);
  const prevLast = perm(n, lv + (cyc - 1))[n - 1];
  if (cur[0] === prevLast) [cur[0], cur[1]] = [cur[1], cur[0]];
  return cur[pos];
}
// задания дня: по одному каждой сложности, одинаковые для всех
function forDay(day) {
  const dn = Math.round(new Date(day + "T00:00:00Z").getTime() / 86400e3);
  return LEVELS.map(lv => ({ ...POOL[lv][pickIdx(lv, dn)], lv, reward: REWARD[lv] }));
}

function matches(q, ev) {
  if (q.c !== "kill") return q.c === ev.e;
  if (ev.e !== "kill") return false;
  if (q.hs && !ev.hs) return false;
  if (q.knife && !isKnife(ev.w)) return false;
  if (q.w && !q.w.includes(ev.w)) return false;
  return true;
}

function makeQuests({ db, tx, addMoney, eventMult = () => 1, now = Date.now, onDone = () => {}, log = console }) {
  const get = db.prepare("SELECT n, done FROM quest_prog WHERE sid=? AND day=? AND qid=?");
  const up = db.prepare("INSERT INTO quest_prog(sid,day,qid,n,done) VALUES(?,?,?,?,0) ON CONFLICT(sid,day,qid) DO UPDATE SET n=MIN(?, n+excluded.n)");
  const setDone = db.prepare("UPDATE quest_prog SET done=1, n=? WHERE sid=? AND day=? AND qid=? AND done=0");
  const insDone = db.prepare("INSERT INTO quest_prog(sid,day,qid,n,done) VALUES(?,?,?,1,1) ON CONFLICT(sid,day,qid) DO NOTHING");
  const userBySid = db.prepare("SELECT id FROM users WHERE steamid=?");
  const pend = db.prepare("INSERT INTO earn_pending(sid,tk,updated_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET tk=tk+excluded.tk, updated_at=excluded.updated_at");

  // награда: зарегистрированным — сразу на счёт, остальным — копится до первого входа на сайт
  function pay(sid, tk, what, ref) {
    const u = userBySid.get(sid);
    if (u) addMoney(u.id, "tk", tk, "quest", ref, { what });
    else pend.run(sid, tk, now());
  }

  // прибавить прогресс игроку по событию типа c; вернёт выполненные сейчас задания
  function bump(sid, ev, t) {
    if (!sid) return [];
    const out = bumpWeek(sid, ev, t);
    const day = mskDay(t), qs = forDay(day);
    for (const q of qs) {
      if (!matches(q, ev)) continue;
      const cur = get.get(sid, day, q.id);
      if (cur && cur.done) continue;
      try {
        tx(() => {
          up.run(sid, day, q.id, 1, q.goal);
          const n = get.get(sid, day, q.id).n;
          if (n >= q.goal && setDone.run(q.goal, sid, day, q.id).changes) {
            const k = eventMult(t), rw = q.reward * k; // «Пятница заданий» — награды ×2
            pay(sid, rw, `Задание: ${q.n}${k > 1 ? ` (×${k})` : ""}`, `${day}:${q.id}`);
            out.push({ sid, q, reward: rw });
            // все три задания дня — бонус
            const all = qs.every(x => x.id === q.id || (get.get(sid, day, x.id) || {}).done);
            if (all && insDone.run(sid, day, "all").changes) { pay(sid, ALL_BONUS * k, "Все задания дня", `${day}:all`); out.push({ sid, q: { id: "all", n: "Все задания дня" }, reward: ALL_BONUS * k }); }
          }
        });
      } catch (e) { log.error("[quests]", e.message); }
    }
    return out;
  }

  // еженедельные задания: тот же учёт, ключ периода — неделя
  function bumpWeek(sid, ev, t) {
    const wk = weekOf(t).key, out = [];
    for (const q of forWeek(t)) {
      if (!matches(q, ev)) continue;
      const cur = get.get(sid, wk, q.id);
      if (cur && cur.done) continue;
      try {
        tx(() => {
          up.run(sid, wk, q.id, 1, q.goal);
          const n = get.get(sid, wk, q.id).n;
          if (n >= q.goal && setDone.run(q.goal, sid, wk, q.id).changes) {
            const k = eventMult(t), rw = q.reward * k;
            pay(sid, rw, `Задание недели: ${q.n}${k > 1 ? ` (×${k})` : ""}`, `${wk}:${q.id}`);
            out.push({ sid, q, reward: rw, week: true });
          }
        });
      } catch (e) { log.error("[quests]", e.message); }
    }
    return out;
  }

  // события журнала (после gamelog.parseLine); разминку и ботов-стрелков не считаем
  function apply(ev, warm) {
    if (!ev || warm) return [];
    const t = ev.t || now(), human = p => p && p.sid && !p.bot;
    let done = [];
    switch (ev.e) {
      case "kill":
        if (human(ev.a) && ev.v && ev.a.sid !== ev.v.sid && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team)) done = bump(ev.a.sid, ev, t);
        break;
      case "assist": if (human(ev.a) && ev.v && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team)) done = bump(ev.a.sid, ev, t); break;
      case "plant": case "defuse": if (human(ev.a)) done = bump(ev.a.sid, ev, t); break;
    }
    if (done.length) onDone(done);
    return done;
  }
  const many = (sids, e, t) => { const done = []; for (const sid of sids) done.push(...bump(sid, { e }, t)); if (done.length) onDone(done); return done; };
  const roundWin = (sids, t = now()) => many(sids, "roundWin", t);
  const minute = (sids, t = now()) => many(sids, "minute", t);

  // задания дня с прогрессом игрока (для сайта и для игры)
  function state(sid, t = now()) {
    const day = mskDay(t), k = eventMult(t);
    const list = forDay(day).map(q => {
      const p = sid ? get.get(sid, day, q.id) : null;
      return { id: q.id, n: q.n, lv: q.lv, lvn: LEVEL_RU[q.lv], goal: q.goal, have: p ? Math.min(q.goal, p.n) : 0, done: !!(p && p.done), reward: q.reward * k };
    });
    const bonus = !!(sid && get.get(sid, day, "all"));
    const w = weekOf(t);
    const week = { key: w.key, ends: w.ends, list: forWeek(t).map(q => {
      const p = sid ? get.get(sid, w.key, q.id) : null;
      return { id: q.id, n: q.n, lv: "week", lvn: "Неделя · " + WEEK_RU[q.step], step: q.step, goal: q.goal, have: p ? Math.min(q.goal, p.n) : 0, done: !!(p && p.done), reward: q.reward * k };
    }) };
    return { day, list, bonus, bonusTk: ALL_BONUS * k, ends: dayEnd(t), x: k, week };
  }
  return { apply, roundWin, minute, state };
}

module.exports = { makeQuests, forDay, forWeek, weekOf, POOL, WEEK, REWARD, ALL_BONUS, mskDay };
