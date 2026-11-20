"use strict";
// Игровые бонусы по журналу CS2: первая кровь, эйс (5 убийств за раунд), награда за голову (серия убийств без смерти)
// и победа в особом раунде (раунд выбирает плагин TasherStyle и пишет в консоль строку «TASHERFUN special_win <режим> <ct|t>»).
// ТК — зарегистрированным сразу на счёт, остальным копятся до первого входа на сайт. Разминка, тимкиллы и самоубийства не считаются.

const FIRST_BLOOD = { human: 20, bot: 5 };
// эйс: если среди убитых хотя бы ACE.minHumans живых игроков — полная награда, иначе (одни боты) — меньше
const ACE = { kills: 5, tk: 100, tkBots: 30, xp: 100, minHumans: 2 };
// награда за голову: объявляется с FROM убийств подряд и растёт каждые STEP убийств
const BOUNTY = { from: 5, step: 3, base: 50, perKill: 10, perHuman: 20, max: 300, botBase: 25, botPerKill: 5, botMax: 60, xp: 50 };
const SPECIAL = { tk: 50, xp: 30 };
const DAY_CAP = 1500; // всех этих бонусов вместе — не больше стольких ТК в сутки (до множителя события)
const MODES = {
  knife: "Только ножи", deagle: "Дуэль на Deagle", awp: "Только AWP", scout: "Скауты в низкой гравитации",
  zeus: "Только Zeus", onehp: "1 HP: пистолеты", nades: "Война гранат",
};
const MSK = 3 * 3600e3;
const mskDay = t => new Date(t + MSK).toISOString().slice(0, 10);
const keyOf = p => (p.sid ? p.sid : "bot:" + p.uid);

// стоимость головы игрока с серией s
function bountyValue(s) {
  if (s.bot) return Math.min(BOUNTY.botMax, BOUNTY.botBase + BOUNTY.botPerKill * (s.n - BOUNTY.from));
  return Math.min(BOUNTY.max, BOUNTY.base + BOUNTY.perKill * (s.n - BOUNTY.from) + BOUNTY.perHuman * s.humans);
}

function makeFun({ db, tx, addMoney, addXp = () => 0, eventMult = () => 1, inGame = () => [], say = () => {}, now = Date.now, log = console }) {
  const userBySid = db.prepare("SELECT id FROM users WHERE steamid=?");
  const pend = db.prepare("INSERT INTO earn_pending(sid,tk,updated_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET tk=tk+excluded.tk, updated_at=excluded.updated_at");
  const dayQ = db.prepare("SELECT tk FROM fun_day WHERE sid=? AND day=?");
  const dayUp = db.prepare("INSERT INTO fun_day(sid,day,tk) VALUES(?,?,?) ON CONFLICT(sid,day) DO UPDATE SET tk=tk+excluded.tk");

  let round = { kills: new Map(), fb: false };
  const streak = new Map(); // key -> { n, humans, name, bot, sid }
  let lastSpecial = 0;
  const fresh = t => now() - t < 90e3; // объявляем только свежее (при перечитывании журнала после перезапуска — молча)

  // начислить ТК (с суточным лимитом и множителем «Счастливого часа»); вернёт, сколько начислено
  function pay(sid, tk, what, ref, t) {
    if (!sid || !(tk > 0)) return 0;
    let got = 0;
    try {
      tx(() => {
        const day = mskDay(t), have = (dayQ.get(sid, day) || {}).tk || 0;
        const b = Math.min(tk, DAY_CAP - have); if (b <= 0) return;
        dayUp.run(sid, day, b);
        got = Math.round(b * eventMult(t));
        const u = userBySid.get(sid);
        if (u) addMoney(u.id, "tk", got, "fun", ref, { what });
        else pend.run(sid, got, now());
      });
    } catch (e) { log.error("[fun]", e.message); got = 0; }
    if (got) log.log(`[fun] ${sid} +${got} ТК: ${what}`);
    return got;
  }
  const xp = (sid, v, t) => { try { addXp(sid, v, t); } catch (e) { log.error("[fun] xp", e.message); } };
  const tkText = (got, want) => (got > 0 ? `+${got} ТК` : want > 0 ? "дневной лимит бонусов уже набран" : "");

  function resetAll() { streak.clear(); round = { kills: new Map(), fb: false }; }

  function onKill(ev, t) {
    const a = ev.a, v = ev.v, human = p => p && p.sid && !p.bot;
    if (!v) return;
    // смерть обрывает серию убитого
    const vk = keyOf(v), vs = streak.get(vk); streak.delete(vk);
    const tk = a && a.team && v.team && a.team === v.team;
    if (!a || keyOf(a) === vk || tk) return; // самоубийство и тимкилл — без наград
    // награда за голову
    if (vs && vs.n >= BOUNTY.from) {
      const val = bountyValue(vs);
      if (human(a)) {
        const got = pay(a.sid, val, `Награда за голову: ${vs.name}`, `bounty:${t}`, t);
        if (got) xp(a.sid, BOUNTY.xp, t);
        if (fresh(t)) say(`[TASHER] ${a.n} снимает награду за голову ${vs.name} (${vs.n} подряд): ${tkText(got, val)}`);
      } else if (fresh(t)) say(`[TASHER] Серию ${vs.name} (${vs.n} подряд) прервал бот ${a.n}. Награда сгорела`);
    }
    // серия убийцы (боты тоже могут стать «целью»)
    const ak = keyOf(a), s = streak.get(ak) || { n: 0, humans: 0, name: a.n, bot: !!a.bot, sid: a.sid };
    s.n++; if (!v.bot) s.humans++; s.name = a.n; streak.set(ak, s);
    if (s.n >= BOUNTY.from && fresh(t)) {
      const val = bountyValue(s);
      if (s.n === BOUNTY.from) say(`[TASHER] Награда за голову: ${s.bot ? "бот " : ""}${s.name} — ${s.n} убийств подряд. Кто остановит — получит ${val} ТК`);
      else if (!s.bot && (s.n - BOUNTY.from) % BOUNTY.step === 0) say(`[TASHER] Награда за ${s.name} растёт: ${val} ТК (${s.n} подряд)`);
      else if (s.bot && s.n === BOUNTY.from * 2) say(`[TASHER] Бот ${s.name} разошёлся: ${s.n} подряд, награда ${val} ТК`);
    }
    // первая кровь и эйс — только живым игрокам
    if (!round.fb) {
      round.fb = true;
      if (human(a)) pay(a.sid, v.bot ? FIRST_BLOOD.bot : FIRST_BLOOD.human, "Первая кровь в раунде", `fb:${t}`, t);
    }
    if (human(a)) {
      const r = round.kills.get(a.sid) || { n: 0, humans: 0 };
      r.n++; if (!v.bot) r.humans++; round.kills.set(a.sid, r);
      if (r.n === ACE.kills) {
        const want = r.humans >= ACE.minHumans ? ACE.tk : ACE.tkBots;
        const got = pay(a.sid, want, "Эйс: 5 убийств за раунд", `ace:${t}`, t);
        if (got) xp(a.sid, ACE.xp, t);
        if (fresh(t)) say(`[TASHER] ЭЙС! ${a.n}: ${ACE.kills} убийств за раунд — ${tkText(got, want)}`);
      }
    }
  }

  // события журнала (после gamelog.parseLine)
  function apply(ev, warm) {
    if (!ev) return;
    const t = ev.t || now();
    switch (ev.e) {
      case "map": case "warmup_start": case "game_commencing": case "match_start": case "logclose": resetAll(); break;
      case "round_start": round = { kills: new Map(), fb: false }; break;
      case "kill": if (!warm) onKill(ev, t); else streak.clear(); break;
      case "suicide": case "leave": case "team": if (ev.a) streak.delete(keyOf(ev.a)); break;
    }
  }

  // строка от плагина: «TASHERFUN special_win knife ct»
  function marker(line, t = now(), warm = false) {
    const m = /^TASHERFUN special_win ([a-z0-9]{1,16}) (ct|t)\s*$/.exec(String(line || ""));
    if (!m || !MODES[m[1]] || warm) return null;
    if (t - lastSpecial < 30e3) return null; // не чаще одного раза на раунд
    lastSpecial = t;
    const kind = m[1], team = m[2];
    const win = inGame().filter(([, tm]) => tm === team).map(([sid]) => sid);
    let got = 0;
    for (const sid of win) { const g = pay(sid, SPECIAL.tk, `Победа в особом раунде «${MODES[kind]}»`, `special:${t}`, t); if (g) xp(sid, SPECIAL.xp, t); got = Math.max(got, g); }
    if (fresh(t)) say(`[TASHER] Особый раунд «${MODES[kind]}» выиграл ${team === "ct" ? "спецназ" : "террористы"}${win.length ? `: +${got || SPECIAL.tk} ТК каждому игроку команды` : ""}`);
    return { kind, team, win };
  }

  // для сайта: у кого сейчас награда за голову
  function bounties() {
    return [...streak.values()].filter(s => s.n >= BOUNTY.from).sort((a, b) => b.n - a.n).slice(0, 5).map(s => ({ n: s.name, k: s.n, v: bountyValue(s), bot: s.bot || undefined }));
  }
  const info = () => ({ firstBlood: FIRST_BLOOD, ace: ACE, bounty: BOUNTY, special: SPECIAL, dayCap: DAY_CAP, modes: MODES });
  return { apply, marker, bounties, info, _streak: streak };
}

module.exports = { makeFun, bountyValue, FIRST_BLOOD, ACE, BOUNTY, SPECIAL, DAY_CAP, MODES };
