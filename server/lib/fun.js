"use strict";
// Игровые бонусы по журналу CS2: первая кровь, эйс (5 убийств за раунд) и победа в особом раунде
// (раунд выбирает плагин TasherStyle и пишет в консоль строку «TASHERFUN special_win <режим> <ct|t>»).
// ТК — зарегистрированным сразу на счёт, остальным копятся до первого входа на сайт. Разминка, тимкиллы и самоубийства не считаются.
// В чат игры пишем только итог особого раунда; первая кровь и эйс — молча (в игре у убившего только звук).

const FIRST_BLOOD = { human: 20, bot: 5 };
// эйс: если среди убитых хотя бы ACE.minHumans живых игроков — полная награда, иначе (одни боты) — меньше
const ACE = { kills: 5, tk: 100, tkBots: 30, xp: 100, minHumans: 2 };
const SPECIAL = { tk: 50, xp: 30 };
const DAY_CAP = 0; // лимита на бонусы в сутки нет (0 — без лимита; было 1500)
const MODES = {
  knife: "Только ножи", deagle: "Дуэль на Deagle", awp: "Только AWP", scout: "Скауты в низкой гравитации",
  zeus: "Только Zeus", onehp: "1 HP: пистолеты", nades: "Война гранат", invis: "Невидимки",
  wh: "Все с ВХ", hs: "Только в голову", bhop: "Распрыжка", vampire: "Вампиры", ammo: "Бесконечные патроны",
};
const MSK = 3 * 3600e3;
const mskDay = t => new Date(t + MSK).toISOString().slice(0, 10);

function makeFun({ db, tx, addMoney, addXp = () => 0, eventMult = () => 1, inGame = () => [], say = () => {}, now = Date.now, log = console }) {
  const userBySid = db.prepare("SELECT id FROM users WHERE steamid=?");
  const pend = db.prepare("INSERT INTO earn_pending(sid,tk,updated_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET tk=tk+excluded.tk, updated_at=excluded.updated_at");
  const dayQ = db.prepare("SELECT tk FROM fun_day WHERE sid=? AND day=?");
  const dayUp = db.prepare("INSERT INTO fun_day(sid,day,tk) VALUES(?,?,?) ON CONFLICT(sid,day) DO UPDATE SET tk=tk+excluded.tk");

  let round = { kills: new Map(), fb: false };
  let lastSpecial = 0;
  const fresh = t => now() - t < 90e3; // объявляем только свежее (при перечитывании журнала после перезапуска — молча)

  // начислить ТК (с суточным лимитом и множителем «Счастливого часа»); вернёт, сколько начислено
  function pay(sid, tk, what, ref, t) {
    if (!sid || !(tk > 0)) return 0;
    let got = 0;
    try {
      tx(() => {
        const day = mskDay(t), have = (dayQ.get(sid, day) || {}).tk || 0;
        const b = DAY_CAP > 0 ? Math.min(tk, DAY_CAP - have) : tk; if (b <= 0) return;
        dayUp.run(sid, day, b);
        got = Math.round(b * eventMult(t));
        const u = userBySid.get(sid);
        if (u) addMoney(u.id, "tk", got, "fun", ref, { what });
        else pend.run(sid, got, now());
      });
    } catch (e) { log.error("[fun]", e.message); got = 0; }
    if (got) log.log(`[fun] ${sid} +${got} ТК: ${what}`);
    // счётчик для достижений (первая кровь, эйс) — даже если ТК уже не начислились
    const kind = String(ref).split(":")[0];
    if (kind === "fb" || kind === "ace") { try { db.prepare("INSERT INTO fun_count(sid,kind,n) VALUES(?,?,1) ON CONFLICT(sid,kind) DO UPDATE SET n=n+1").run(sid, kind); } catch (e) { log.error("[fun] count", e.message); } }
    return got;
  }
  const xp = (sid, v, t) => { try { addXp(sid, v, t); } catch (e) { log.error("[fun] xp", e.message); } };

  function onKill(ev, t) {
    const a = ev.a, v = ev.v, human = p => p && p.sid && !p.bot;
    if (!a || !v) return;
    if ((a.sid ? a.sid === v.sid : a.uid === v.uid) || (a.team && v.team && a.team === v.team)) return; // самоубийство и тимкилл — без наград
    if (!round.fb) {
      round.fb = true;
      if (human(a)) pay(a.sid, v.bot ? FIRST_BLOOD.bot : FIRST_BLOOD.human, "Первая кровь в раунде", `fb:${t}`, t);
    }
    if (!human(a)) return;
    const r = round.kills.get(a.sid) || { n: 0, humans: 0 };
    r.n++; if (!v.bot) r.humans++; round.kills.set(a.sid, r);
    if (r.n === ACE.kills) {
      const got = pay(a.sid, r.humans >= ACE.minHumans ? ACE.tk : ACE.tkBots, "Эйс: 5 убийств за раунд", `ace:${t}`, t);
      if (got) xp(a.sid, ACE.xp, t);
    }
  }

  // события журнала (после gamelog.parseLine)
  function apply(ev, warm) {
    if (!ev) return;
    const t = ev.t || now();
    switch (ev.e) {
      case "map": case "warmup_start": case "game_commencing": case "match_start": case "logclose": case "round_start": round = { kills: new Map(), fb: false }; break;
      case "kill": if (!warm) onKill(ev, t); break;
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

  const info = () => ({ firstBlood: FIRST_BLOOD, ace: ACE, special: SPECIAL, dayCap: DAY_CAP, modes: MODES });
  return { apply, marker, info };
}

module.exports = { makeFun, FIRST_BLOOD, ACE, SPECIAL, DAY_CAP, MODES };
