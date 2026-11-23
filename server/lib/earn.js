"use strict";
// ТК за игру на сервере: начисляются по журналу CS2 и за время в игре.
// Сначала копятся в базе (earn_pending), раз в 30 секунд зачисляются на счёт — одной строкой в журнале операций.
// Кто ещё не заходил на сайт, получит накопленное при первом входе через Steam.

// сколько ТК за что (до множителя статуса)
const RATES = { kill: 5, killBot: 1, hs: 1, assist: 2, plant: 3, defuse: 5, roundWin: 2, minute: 1 };
const DAILY_CAP = 2000; // в сутки по Москве, до множителя
const MULT = { VIP: 1.1, PREMIUM: 1.2, ELITE: 1.3, LEGEND: 1.5, TITAN: 1.75, KING: 2 };
const mskDay = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);

function makeEarn({ db, tx, addMoney, statusOf, eventMult = () => 1, boostMult = () => 1, now = Date.now, log = console }) {
  const dayQ = db.prepare("SELECT base FROM earn_day WHERE sid=? AND day=?");
  const dayUp = db.prepare("INSERT INTO earn_day(sid,day,base) VALUES(?,?,?) ON CONFLICT(sid,day) DO UPDATE SET base=base+excluded.base");
  const penUp = db.prepare("INSERT INTO earn_pending(sid,tk,updated_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET tk=tk+excluded.tk, updated_at=excluded.updated_at");

  // начислить base очков игроку (с учётом дневного лимита и множителя статуса)
  function add(sid, base, t) {
    if (!sid || !(base > 0)) return 0;
    const day = mskDay(t), have = (dayQ.get(sid, day) || {}).base || 0;
    const b = Math.min(base, DAILY_CAP - have); if (b <= 0) return 0;
    const st = statusOf(sid), m = ((st && MULT[st]) || 1) * eventMult(t) * boostMult(sid, t); // статус, событие («Счастливый час» ×2) и буст из пропуска
    dayUp.run(sid, day, b);
    penUp.run(sid, b * m, now());
    return b * m;
  }

  // события журнала (после разбора gamelog.parseLine); разминку и ботов не считаем
  function apply(ev, warm) {
    if (!ev || warm) return;
    const t = ev.t || now(), human = p => p && p.sid && !p.bot;
    switch (ev.e) {
      case "kill":
        if (human(ev.a) && ev.v && ev.a.sid !== ev.v.sid && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team))
          add(ev.a.sid, (ev.v.bot ? RATES.killBot : RATES.kill) + (ev.hs ? RATES.hs : 0), t);
        break;
      case "assist": if (human(ev.a) && ev.v && !(ev.a.team && ev.v.team && ev.a.team === ev.v.team)) add(ev.a.sid, RATES.assist, t); break;
      case "plant": if (human(ev.a)) add(ev.a.sid, RATES.plant, t); break;
      case "defuse": if (human(ev.a)) add(ev.a.sid, RATES.defuse, t); break;
    }
  }
  // победа в раунде: всем людям победившей команды (список даёт статистика)
  function roundWin(sids, t) { for (const sid of sids) add(sid, RATES.roundWin, t); }
  // время в игре: раз в минуту всем, кто сейчас на сервере
  function minute(sids, t) { for (const sid of sids) add(sid, RATES.minute, t); }

  // зачисление накопленного на счёт зарегистрированным
  function flush() {
    const rows = db.prepare("SELECT p.sid, p.tk, u.id uid FROM earn_pending p JOIN users u ON u.steamid=p.sid WHERE p.tk>=1").all();
    let n = 0;
    for (const r of rows) {
      try {
        tx(() => {
          const whole = Math.floor(r.tk);
          addMoney(r.uid, "tk", whole, "game", null, { what: "ТК за игру на сервере" });
          db.prepare("UPDATE earn_pending SET tk=tk-? WHERE sid=?").run(whole, r.sid);
        });
        n++;
      } catch (e) { log.error("[earn] не удалось зачислить ТК:", e.message); }
    }
    return n;
  }
  function today(sid, t = now()) {
    const st = statusOf(sid);
    return { base: (dayQ.get(sid, mskDay(t)) || {}).base || 0, cap: DAILY_CAP, mult: +(((st && MULT[st]) || 1) * eventMult(t) * boostMult(sid, t)).toFixed(2), ev: eventMult(t), boost: boostMult(sid, t), pending: Math.floor((db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(sid) || {}).tk || 0) };
  }
  return { apply, roundWin, minute, flush, today, add };
}

module.exports = { makeEarn, RATES, DAILY_CAP, MULT };
