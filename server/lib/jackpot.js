"use strict";
// Джекпот: общий раунд на скины из инвентаря. Шанс игрока = доля стоимости его скинов в банке, победитель забирает все скины.
// Как только в раунде двое — 35 секунд на ставки, затем 8 секунд вращения и 5 секунд показа победителя.
// Скины в ставке заблокированы (state='jp'). Если за 10 минут второй игрок не пришёл — ставка возвращается.
const crypto = require("node:crypto");

const COUNT = 35e3, SPIN = 8e3, SHOW = 5e3, MAXP = 10, MAXI = 10, LONELY = 600e3, CLOSE_BEFORE = 3e3;
const rnd = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

function makeJackpot({ db, tx, takeItems, itemValue, isAgent, pubItem, onLock = () => {}, onWin = () => {}, now = Date.now, log = console, rand = rnd }) {
  const cur = () => db.prepare("SELECT * FROM jp_rounds WHERE state IN ('open','spin') ORDER BY id DESC LIMIT 1").get() || null;
  const lastDone = () => db.prepare("SELECT * FROM jp_rounds WHERE state='done' ORDER BY id DESC LIMIT 1").get() || null;
  const bets = rid => db.prepare("SELECT b.*, u.name, u.avatar, u.steamid FROM jp_bets b JOIN users u ON u.id=b.user_id WHERE b.round_id=? ORDER BY b.id").all(rid);
  // игроки раунда в порядке первой ставки
  function players(rid) {
    const out = [], by = new Map();
    for (const b of bets(rid)) {
      let p = by.get(b.user_id);
      if (!p) { p = { uid: b.user_id, n: b.name || ("Player" + b.user_id), av: b.avatar, sid: b.steamid, v: 0, ids: [] }; by.set(b.user_id, p); out.push(p); }
      p.v += b.value; p.ids.push(b.item_id);
    }
    return out;
  }
  const phase = (R, t = now()) => !R ? "wait" : R.state === "done" ? (t < R.spin + SPIN + SHOW ? "show" : "over") : R.spin ? (t >= R.spin + SPIN ? "show" : "spin") : R.cd ? "count" : "wait";

  function bet(u, ids) {
    if (!Array.isArray(ids) || !ids.length) { const e = new Error("Выбери скины"); e.code = 400; throw e; }
    const out = tx(() => {
      const t = now();
      let R = cur();
      if (R && R.state !== "open") { const e = new Error("Идёт розыгрыш, ставки откроются в следующем раунде"); e.code = 409; throw e; }
      if (R && R.cd && R.cd - t <= CLOSE_BEFORE) { const e = new Error("Ставки на этот раунд закрыты"); e.code = 409; throw e; }
      if (!R) { const id = db.prepare("INSERT INTO jp_rounds(created_at) VALUES(?)").run(t).lastInsertRowid; R = db.prepare("SELECT * FROM jp_rounds WHERE id=?").get(id); }
      const ps = players(R.id), me = ps.find(p => p.uid === u.id);
      if (!me && ps.length >= MAXP) { const e = new Error(`В этом раунде уже ${MAXP} участников, жди следующий`); e.code = 409; throw e; }
      if ((me ? me.ids.length : 0) + ids.length > MAXI) { const e = new Error(`Не больше ${MAXI} скинов за раунд`); e.code = 400; throw e; }
      const rows = takeItems(u.id, ids, "jp");
      let sum = 0;
      for (const r of rows) {
        const v = itemValue(r);
        if (r.fx || isAgent(r.w) || !(v > 0)) { const e = new Error("Этот предмет нельзя поставить"); e.code = 400; throw e; }
        db.prepare("INSERT INTO jp_bets(round_id,user_id,item_id,value,created_at) VALUES(?,?,?,?,?)").run(R.id, u.id, r.id, v, t);
        sum += v;
      }
      const np = me ? ps.length : ps.length + 1;
      db.prepare("UPDATE jp_rounds SET total=total+?, cd=CASE WHEN cd=0 AND ?>=2 THEN ? ELSE cd END WHERE id=?").run(sum, np, t + COUNT, R.id);
      return { round: R.id, sum, n: rows.length };
    });
    onLock(u);
    return out;
  }

  // выбор победителя: случайная точка в банке; pt — где на круге остановится стрелка
  function pick(ps, total) {
    const x = rand() * total; let acc = 0;
    for (let i = 0; i < ps.length; i++) {
      const v = ps[i].v;
      if (x < acc + v || i === ps.length - 1) { const f = Math.min(.94, Math.max(.06, (x - acc) / Math.max(1, v))); return { i, pt: (acc + v * f) / total }; }
      acc += v;
    }
    return { i: 0, pt: .5 };
  }

  // ход времени: запуск вращения, выдача выигрыша, возврат одиночной ставки
  function tick(t = now()) {
    const R = cur(); if (!R) return null;
    if (R.state === "open" && R.cd && t >= R.cd) {
      const ps = players(R.id); if (!ps.length) return null;
      const w = pick(ps, R.total);
      db.prepare("UPDATE jp_rounds SET state='spin', spin=?, win_user=?, pt=? WHERE id=? AND state='open'").run(R.cd, ps[w.i].uid, w.pt, R.id);
      return "spin";
    }
    if (R.state === "spin" && t >= R.spin + SPIN) {
      let winner = null;
      tx(() => {
        const ids = db.prepare("SELECT item_id FROM jp_bets WHERE round_id=?").all(R.id).map(r => r.item_id);
        for (const id of ids) db.prepare("UPDATE items SET user_id=?, state='inv', src='jackpot', src_ref=?, closed_at=NULL WHERE id=? AND state='jp'").run(R.win_user, String(R.id), id);
        db.prepare("UPDATE jp_rounds SET state='done' WHERE id=?").run(R.id);
        winner = db.prepare("SELECT * FROM users WHERE id=?").get(R.win_user);
      });
      log.log(`[jackpot] раунд ${R.id}: банк ${R.total} ТК забрал ${winner && winner.name}`);
      try { onWin(winner, R); } catch (e) {}
      return "done";
    }
    if (R.state === "open" && !R.cd && t - R.created_at > LONELY) {
      tx(() => {
        for (const b of db.prepare("SELECT item_id FROM jp_bets WHERE round_id=?").all(R.id)) db.prepare("UPDATE items SET state='inv', closed_at=NULL WHERE id=? AND state='jp'").run(b.item_id);
        db.prepare("UPDATE jp_rounds SET state='cancelled' WHERE id=?").run(R.id);
      });
      return "cancelled";
    }
    return null;
  }

  // состояние для сайта: текущий раунд (или только что разыгранный — пока показываем победителя) и история
  function view(u, t = now()) {
    let R = cur();
    if (!R) { const D = lastDone(); if (D && t < D.spin + SPIN + SHOW) R = D; }
    let round = null;
    if (R) {
      const ps = players(R.id);
      const items = new Map(db.prepare("SELECT i.* FROM items i JOIN jp_bets b ON b.item_id=i.id WHERE b.round_id=?").all(R.id).map(r => [r.id, r]));
      round = {
        id: R.id, rn: R.id, t0: R.created_at, cd: R.cd, spin: R.spin, pt: R.pt, done: R.state === "done" ? 1 : 0,
        win: R.win_user ? ps.findIndex(p => p.uid === R.win_user) : null,
        players: ps.map(p => ({ n: p.n, av: p.av, me: !!u && p.uid === u.id, v: p.v, items: p.ids.map(id => items.get(id)).filter(Boolean).map(pubItem) })),
      };
      if (round.win != null && round.win < 0) round.win = null;
    }
    const hist = db.prepare("SELECT * FROM jp_rounds WHERE state='done' ORDER BY id DESC LIMIT 30").all().map(H => {
      const ps = players(H.id), w = ps.find(p => p.uid === H.win_user) || ps[0], my = u ? (ps.find(p => p.uid === u.id) || { v: 0 }).v : 0;
      const top = db.prepare("SELECT i.* FROM items i JOIN jp_bets b ON b.item_id=i.id WHERE b.round_id=? ORDER BY b.value DESC LIMIT 4").all(H.id).map(pubItem);
      const k = db.prepare("SELECT COUNT(*) n FROM jp_bets WHERE round_id=?").get(H.id).n;
      return { id: H.id, n: w ? w.n : "?", me: !!u && H.win_user === u.id, v: H.total, ch: w ? w.v / Math.max(1, H.total) : 0, t: H.spin + SPIN, k, np: ps.length, my, top };
    });
    return { now: t, round, hist, rules: { COUNT, SPIN, SHOW, MAXP, MAXI, CLOSE_BEFORE, LONELY } };
  }
  return { bet, tick, view, phase, pick };
}

module.exports = { makeJackpot, COUNT, SPIN, SHOW, MAXP, MAXI, LONELY };
