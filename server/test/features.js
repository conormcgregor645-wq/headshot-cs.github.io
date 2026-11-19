"use strict";
// ТК за игру, Фортуна, джекпот, кланы, стиль в игре: node test/features.js
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const { open, tx } = require("../lib/db");
const GL = require("../lib/gamelog");
const { makeEarn, DAILY_CAP } = require("../lib/earn");
const { makeWheel, SEGS } = require("../lib/wheel");
const { makeJackpot } = require("../lib/jackpot");
const { makeClans, COST } = require("../lib/clans");
const STYLE = require("../lib/style");
const QM = require("../lib/quests");
const INFO = require("../lib/gameinfo");
const { prevMonth } = require("../lib/control");
let fails = 0; const ok = (c, n, x) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + n + (c ? "" : " " + JSON.stringify(x))); };
const thr = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message) ? e : false; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasher-ft-")), db = open(path.join(dir, "t.db"));
const ST = GL.makeStats(db); // таблицы статистики
const T = fn => tx(db, fn);
let NOW = Date.UTC(2026, 10, 19, 12); const now = () => NOW;
function addMoney(uid, cur, delta, kind, ref, meta) {
  const u = db.prepare(`SELECT ${cur} v FROM users WHERE id=?`).get(uid), after = u.v + delta;
  if (after < 0) { const e = new Error(cur === "tk" ? `Не хватает ${-after} ТК` : `Не хватает ${-after} ₽`); e.code = 402; throw e; }
  db.prepare(`UPDATE users SET ${cur}=? WHERE id=?`).run(after, uid);
  db.prepare("INSERT INTO ledger(user_id,cur,delta,after,kind,ref,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(uid, cur, delta, after, kind, ref || null, meta ? JSON.stringify(meta) : null, NOW);
  return after;
}
const sidN = n => String(76561197960265728n + BigInt(n));
function user(n, tk = 0, rub = 0) {
  const id = db.prepare("INSERT INTO users(steamid,name,created_at,last_login,tk,rub) VALUES(?,?,?,?,?,?)").run(sidN(n), "U" + n, NOW, NOW, tk, rub).lastInsertRowid;
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}
const bal = u => db.prepare("SELECT tk, rub FROM users WHERE id=?").get(u.id);

// ---------- ТК за игру ----------
{
  const tiers = new Map();
  const E = makeEarn({ db, tx: T, addMoney, statusOf: sid => tiers.get(sid) || null, now });
  const a = user(1), k = user(2); tiers.set(k.steamid, "KING");
  const L = (n, u, team) => `"${n}<${u}><[U:1:${u}]><${team}>"`, B = (n, u, team) => `"${n}<${u}><BOT><${team}>"`;
  const ev = s => GL.parseLine("L 11/19/2026 - 15:00:00: " + s);
  E.apply(ev(`${L("U1", 1, "CT")} [0 0 0] killed ${L("X", 5, "TERRORIST")} [0 0 0] with "ak47" (headshot)`), false); // 5+1
  E.apply(ev(`${L("U1", 1, "CT")} [0 0 0] killed ${B("Bot", 7, "TERRORIST")} [0 0 0] with "ak47"`), false);           // 1
  E.apply(ev(`${L("U1", 1, "CT")} [0 0 0] killed ${L("X", 5, "TERRORIST")} [0 0 0] with "ak47"`), true);              // разминка — 0
  E.apply(ev(`${L("U1", 1, "CT")} [0 0 0] killed ${L("Y", 6, "CT")} [0 0 0] with "ak47"`), false);                   // свой — 0
  E.apply(ev(`${L("U1", 1, "TERRORIST")} triggered "Planted_The_Bomb"`), false);                                     // 3
  E.roundWin([a.steamid], NOW); E.minute([a.steamid], NOW);                                                        // 2 + 1
  ok(E.today(a.steamid).base === 13, "ТК за игру: убийство с хедшотом, бот, бомба, победа в раунде, минута; разминка и свои не в счёт", E.today(a.steamid));
  E.minute([k.steamid], NOW); E.minute([k.steamid], NOW);
  ok(E.today(k.steamid).pending === 4, "множитель статуса KING ×2", E.today(k.steamid));
  E.add(a.steamid, 5000, NOW); ok(E.today(a.steamid).base === DAILY_CAP, "дневной лимит", E.today(a.steamid));
  NOW += 864e5; E.minute([a.steamid], NOW); ok(E.today(a.steamid).base === 1, "на следующий день лимит сбрасывается"); NOW -= 864e5;
  E.minute([sidN(99)], NOW); E.minute([sidN(99)], NOW);
  E.flush();
  ok(bal(a).tk === DAILY_CAP + 1 && bal(k).tk === 4, "ТК зачислены на счёт", [bal(a), bal(k)]);
  ok(db.prepare("SELECT kind FROM ledger WHERE user_id=? ORDER BY id DESC").get(a.id).kind === "game", "запись в журнале операций — «за игру»");
  const late = user(99); E.flush(); ok(bal(late).tk === 2, "кто зашёл на сайт позже — получает накопленное", bal(late));
  E.flush(); ok(bal(a).tk === DAILY_CAP + 1, "повторно не зачисляется");
}

// ---------- Фортуна ----------
{
  const tiers = new Map(), grants = [];
  let next = [{ r: 0, i: 0 }];
  const W = makeWheel({ db, tx: T, addMoney, addGrant: (...a) => grants.push(a), statusOf: sid => tiers.get(sid) || null, now, pickFn: () => next.shift() });
  const u = user(10);
  ok(W.state(u).canSpin, "Фортуна: можно крутить");
  let r = W.spin(u); ok(r.i === 0 && bal(u).tk === 150 && r.streak === 1 && !r.again, "обычный приз 150 ТК, серия 1", r);
  ok(thr(() => W.spin(u), /уже получен/), "второй раз за день нельзя");
  // ELITE: при обычном призе ещё попытка
  const e = user(11); tiers.set(e.steamid, "ELITE"); next = [{ r: 0, i: 2 }, { r: 0, i: 4 }];
  r = W.spin(e); ok(r.again && W.state(e).canSpin, "ELITE: обычный приз — ещё одна попытка", r);
  r = W.spin(e); ok(!r.again && !W.state(e).canSpin && bal(e).tk === 300 + 450 && r.streak === 1, "вторая попытка одна, серия не растёт дважды", [r, bal(e)]);
  // серия 7 дней и бонус
  const s = user(12); let b0 = 0;
  for (let d = 0; d < 7; d++) { next = [{ r: 0, i: 0 }]; r = W.spin(s, NOW + d * 864e5); }
  ok(r.streak === 7 && r.bonus === 3000 && bal(s).tk === 150 * 7 + 3000, "7 дней подряд — бонус 3000 ТК", [r, bal(s)]);
  next = [{ r: 0, i: 0 }]; r = W.spin(s, NOW + 9 * 864e5); ok(r.streak === 1, "пропуск дня — серия заново", r);
  // рубли и статус
  const p = user(13); next = [{ r: 3, i: 6 }]; r = W.spin(p);
  ok(r.tier === "LEGEND" && grants.length === 1 && grants[0][0] === p.steamid && grants[0][1] === "LEGEND" && grants[0][2] === 14, "статус LEGEND 14 дней", [r, grants]);
  const q = user(14); next = [{ r: 3, i: 10 }]; W.spin(q); ok(bal(q).rub === 250, "250 ₽ на баланс", bal(q));
  ok(SEGS.length === 12, "12 призов, как на сайте");
}

// ---------- джекпот ----------
{
  let iid = 0; const items = new Map();
  const give = (u, v) => { const id = "it" + (++iid); db.prepare("INSERT INTO items(id,user_id,w,s,r,wear,src,created_at,fx) VALUES(?,?,?,?,?,?,?,?,?)").run(id, u.id, "AK-47", "Redline", 3, .1, "test", NOW, 0); items.set(id, v); return id; };
  const takeItems = (uid, ids, state) => { const rows = []; for (const id of new Set(ids)) { const r = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(id, uid); if (!r) { const e = new Error("Предмет не найден или уже использован"); e.code = 409; throw e; } rows.push(r); } for (const r of rows) db.prepare("UPDATE items SET state=? WHERE id=?").run(state, r.id); return rows; };
  let rv = .7;
  const J = makeJackpot({ db, tx: T, takeItems, itemValue: r => items.get(r.id) || 0, isAgent: () => false, pubItem: r => ({ id: r.id }), now, rand: () => rv, log: { log() {} } });
  const a = user(20), b = user(21), c = user(22);
  const a1 = give(a, 300), a2 = give(a, 100), b1 = give(b, 600), c1 = give(c, 50);
  let r = J.bet(a, [a1, a2]); let v = J.view(a);
  ok(r.sum === 400 && v.round.players.length === 1 && v.round.players[0].me && !v.round.cd && J.phase(db.prepare("SELECT * FROM jp_rounds").get()) === "wait", "первая ставка: ждём второго игрока", v.round);
  ok(db.prepare("SELECT state FROM items WHERE id=?").get(a1).state === "jp", "скины в ставке заблокированы");
  ok(thr(() => J.bet(a, [a1]), /не найден/), "тот же скин второй раз не поставить");
  NOW += 1000; J.bet(b, [b1]); v = J.view(b);
  ok(v.round.cd === NOW + 35e3 && v.round.players.length === 2, "двое — 35 секунд на ставки", v.round);
  NOW += 33e3; ok(thr(() => J.bet(c, [c1]), /закрыты/), "за 3 секунды до конца ставки закрыты");
  NOW += 2e3; ok(J.tick() === "spin", "время вышло — розыгрыш");
  v = J.view(a); ok(v.round.win === 1 && v.round.pt > .4 && v.round.pt < 1, "победитель по случайной точке банка (0.7 → второй игрок)", v.round);
  ok(thr(() => J.bet(c, [c1]), /розыгрыш/), "во время вращения ставок нет");
  NOW += 8e3; ok(J.tick() === "done", "после вращения — выдача");
  ok([a1, a2, b1].every(id => { const r = db.prepare("SELECT user_id, state FROM items WHERE id=?").get(id); return r.user_id === b.id && r.state === "inv"; }), "победитель получил все скины");
  v = J.view(a); ok(v.round && v.round.done && v.hist.length === 1 && v.hist[0].v === 1000 && v.hist[0].my === 400 && !v.hist[0].me && v.hist[0].np === 2, "показ победителя и история", v);
  NOW += 6e3; v = J.view(a); ok(v.round === null, "после показа — новый раунд");
  // одиночная ставка возвращается через 10 минут
  J.bet(c, [c1]); NOW += 601e3; ok(J.tick() === "cancelled" && db.prepare("SELECT state FROM items WHERE id=?").get(c1).state === "inv", "никто не пришёл за 10 минут — ставка вернулась");
  // лимиты
  const many = Array.from({ length: 11 }, () => give(a, 10));
  ok(thr(() => J.bet(a, many), /Не больше 10/), "не больше 10 скинов за раунд");
  ok(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND state='jp'").get(a.id).n === 0, "при отказе ничего не заблокировано");
}

// ---------- кланы ----------
{
  const C = makeClans({ db, tx: T, addMoney, month: GL.month, prevMonth, now, log: { log() {} } });
  const L = user(30, 60000, 1000), m1 = user(31), m2 = user(32, 0, 500), m3 = user(33, 60000);
  ok(thr(() => C.create(m1, { name: "Волки", tag: "WOLF" }), /Не хватает/), "без 50 000 ТК клан не создать");
  ok(thr(() => C.create(L, { name: "Во", tag: "WOLF" }), /от 3 до 24/) && thr(() => C.create(L, { name: "Волки", tag: "W" }), /от 2 до 5/), "проверка названия и тега");
  const { id } = C.create(L, { name: "Волки Севера", tag: "wolf", color: "#5aa9ff", desc: "Играем вечером" });
  ok(bal(L).tk === 60000 - COST, "создание клана списало 50 000 ТК");
  ok(thr(() => C.create(m3, { name: "волки севера", tag: "ABC" }), /названием уже есть/) && thr(() => C.create(m3, { name: "Другие", tag: "Wolf" }), /уже занят/), "название и тег уникальны без учёта регистра");
  C.apply(m1, id); C.apply(m2, id);
  let l = C.list(L); ok(l.my.lead && l.my.apps.length === 2 && l.clans[0].members.length === 1 && l.clans[0].t === "WOLF", "лидер видит заявки", l.my);
  ok(C.list(m1).myApps.includes(id), "игрок видит свою заявку");
  C.decide(L, l.my.apps[0].id, true); C.decide(L, l.my.apps[1].id, false);
  l = C.list(L); ok(l.clans[0].members.length === 2 && l.my.apps.length === 0 && !C.clanOfUser(m2.id), "заявка принята, вторая отклонена");
  ok(thr(() => C.decide(m1, 1, true), /не найдена|только лидер/), "не лидер не принимает");
  ok(thr(() => C.leave(L), /передай лидерство/), "лидер не уходит, пока есть участники");
  C.transfer(L, m1.id); ok(C.list(m1).my.lead, "лидерство передано");
  C.leave(L); ok(!C.clanOfUser(L.id), "бывший лидер вышел");
  // казна
  C.apply(m2, id); C.decide(m1, C.list(m1).my.apps[0].id, true);
  C.deposit(m2, 250); ok(bal(m2).rub === 250 && C.list(m2).my.bank === 250, "казна пополнена с баланса участника");
  ok(thr(() => C.deposit(m2, 77), /Пополнить можно/), "сумма пополнения из списка");
  ok(thr(() => C.upgrade(m2, { what: "slots" }), /только лидер/), "тратит казну только лидер");
  C.upgrade(m1, { what: "color", v: "#ff8a3d" }); C.upgrade(m1, { what: "emb", v: "wolf" });
  l = C.list(m1); ok(l.my.bank === 2 && l.clans[0].c === "#ff8a3d" && l.clans[0].emb === "wolf" && l.my.log.length === 3, "улучшения из казны и история", l.my);
  ok(thr(() => C.upgrade(m1, { what: "slots" }), /не хватает/), "без денег в казне улучшение не купить");
  // рейтинг клана и итоги месяца
  const line = (d, s) => GL.parseLine(`L 10/${d}/2026 - 15:00:00: ` + s);
  for (let i = 0; i < 10; i++) ST.apply(line(10, `"U31<3><[U:1:31]><CT>" [0 0 0] killed "B<9><BOT><TERRORIST>" [0 0 0] with "ak47"`));
  for (let i = 0; i < 5; i++) ST.apply(line(10, `"U32<4><[U:1:32]><CT>" [0 0 0] killed "B<9><BOT><TERRORIST>" [0 0 0] with "ak47"`));
  const { id: id2 } = C.create(m3, { name: "Бетон", tag: "BTN" });
  ST.apply(line(11, `"U33<5><[U:1:33]><CT>" [0 0 0] killed "B<9><BOT><TERRORIST>" [0 0 0] with "ak47"`));
  ok(C.runAwards(Date.UTC(2026, 10, 1, 1)) === "2026-10", "итоги месяца для кланов");
  ok(bal(m1).tk === 60000 && bal(m2).tk === 60000 && bal(m3).tk === 60000 - COST + 80000, "приз делится поровну: 1 место 120 000 на двоих, 2 место 80 000 одному", [bal(m1), bal(m2), bal(m3)]);
  ok(C.runAwards(Date.UTC(2026, 10, 1, 2)) === null, "итоги один раз");
  // роспуск: последний уходит — казна возвращается
  C.kick(m1, m2.id); const r0 = bal(m1).rub; C.leave(m1);
  ok(!db.prepare("SELECT 1 FROM clans WHERE id=?").get(id) && bal(m1).rub === r0 + 2, "последний вышел — клан распущен, казна вернулась", bal(m1));
  ok(thr(() => C.create(m3, { name: "X", tag: "XX", ava: "data:image/svg+xml;base64,AAAA" }), /формате|в клане/), "картинки только jpg/png/webp");
}

// ---------- стиль в игре ----------
{
  const c = STYLE.compose({ tier: "ELITE", clanTag: "WOLF", clanColor: "#5aa9ff", nick: "nk_0", tag: "", smokeHex: "#ff6b8b" });
  ok(c.chat === "{green}[ELITE] {lightblue}[WOLF]" && c.name === "lime" && c.score === "WOLF" && c.smoke === "255,107,139", "стиль: статус, клан, цвет ника, дым", c);
  const k = STYLE.compose({ tier: "KING", tag: "PRO", clanTag: "WOLF" });
  ok(k.chat === "{gold}[KING] {lime}[PRO]" && k.score === "PRO" && k.smoke === "random" && k.name === "gold", "свой тег вместо клана, у KING случайный дым", k);
  const f = STYLE.compose({ tier: null, killFx: "ring", killSnd: "8bit", trailHex: "#ffffff", tracerHex: "#eb4b4b" });
  ok(f.killFx === "ring" && f.killSnd === "8bit" && f.trail === "255,255,255" && f.tracer === "235,75,75" && f.chat === "" && f.smoke === "", "эффекты: убийство, звук, след гранат, трассеры", f);
  const bad = STYLE.compose({ killFx: "x';DROP", killSnd: "play quit", trailHex: "red", tracerHex: "#12" });
  ok(!bad.killFx && !bad.killSnd && !bad.trail && !bad.tracer, "чужие значения эффектов не проходят", bad);
  ok(/kill_fx,kill_snd,trail,tracer\) VALUES \(\d{17},'','','','','ring','8bit','255,255,255','235,75,75'\)/.test(STYLE.sqlFor([{ sid: sidN(2), killFx: "ring", killSnd: "8bit", trailHex: "#ffffff", tracerHex: "#eb4b4b" }], true)), "эффекты пишутся в таблицу плагина");
  ok(!/kill_fx/.test(STYLE.sqlFor([{ sid: sidN(2), killFx: "ring" }], false)), "старый плагин без колонок эффектов — пишем без них");
  const sql = STYLE.sqlFor([{ sid: sidN(1), tag: "a'b{red}" }, { sid: "123" }]);
  ok(!/\{red\}/.test(sql) && !/a'b/.test(sql) && (sql.match(/\(\d{17},/g) || []).length === 1, "в SQL нет кавычек и цветовых вставок из своего тега", sql);
}

// ---------- ежедневные задания ----------
{
  // набор на день: по одному каждой сложности, у всех одинаковый, соседние дни не повторяются
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 1) + i * 86400e3).toISOString().slice(0, 10));
  let okDays = true, okNext = true;
  for (let i = 0; i < days.length; i++) {
    const L = QM.forDay(days[i]);
    if (L.map(x => x.lv).join() !== "easy,medium,hard" || JSON.stringify(L) !== JSON.stringify(QM.forDay(days[i]))) okDays = false;
    if (i && L.some((x, k) => x.id === QM.forDay(days[i - 1])[k].id)) okNext = false;
  }
  ok(okDays, "задания дня: лёгкое, среднее, сложное — одинаковые для всех");
  ok(okNext, "задания не повторяются два дня подряд");
  const all = Object.values(QM.POOL).flat(); ok(new Set(all.map(x => x.id)).size === all.length && all.every(x => x.goal > 0 && x.n), "у заданий уникальные коды и цели");

  const done = [];
  const Q = QM.makeQuests({ db, tx: T, addMoney, now, onDone: d => done.push(...d), log: { error() {} } });
  const day = QM.mskDay(NOW), list = QM.forDay(day);
  const u = user(301), sid = u.steamid, other = sidN(399), stranger = sidN(398);
  const evFor = (q, a = sid) => {
    if (q.c === "kill") return { t: NOW, e: "kill", a: { sid: a, team: "ct" }, v: { sid: other, team: "t" }, w: q.w ? q.w[0] : q.knife ? "knife_karambit" : "ak47", hs: !!q.hs };
    if (q.c === "assist") return { t: NOW, e: "assist", a: { sid: a, team: "ct" }, v: { sid: other, team: "t" } };
    return { t: NOW, e: q.c, a: { sid: a, team: "ct" } };
  };
  const step = (q, a = sid, warm = false) => q.c === "roundWin" ? Q.roundWin([a], NOW) : q.c === "minute" ? Q.minute([a], NOW) : Q.apply(evFor(q, a), warm);
  const tk0 = bal(u).tk, q0 = list[0];
  // разминка, убийство своего и бот-стрелок не считаются
  if (q0.c === "kill") {
    Q.apply(evFor(q0), true);
    Q.apply({ ...evFor(q0), v: { sid: other, team: "ct" } }, false);
    Q.apply({ ...evFor(q0), a: { sid: null, bot: true, team: "ct" } }, false);
    ok(Q.state(sid).list[0].have === 0, "разминка, тимкилл и бот не двигают задание", Q.state(sid).list[0]);
  }
  // неподходящее оружие не считается для заданий на оружие
  const wq = list.find(x => x.c === "kill" && (x.w || x.knife));
  if (wq) { const before = Q.state(sid).list.find(x => x.id === wq.id).have; Q.apply({ ...evFor(wq), w: "nova" }, false);
    ok(Q.state(sid).list.find(x => x.id === wq.id).have === before, "задание на оружие: другое оружие не в счёт"); }
  for (let i = 0; i < q0.goal - 1; i++) step(q0);
  let st = Q.state(sid);
  ok(st.list[0].have === q0.goal - 1 && !st.list[0].done && bal(u).tk === tk0, "прогресс копится, награды ещё нет", st.list[0]);
  step(q0); st = Q.state(sid);
  ok(st.list[0].done && bal(u).tk === tk0 + q0.reward && done.some(d => d.q.id === q0.id), "задание выполнено — награда сразу на счёт", { st: st.list[0], tk: bal(u).tk });
  step(q0); step(q0);
  ok(bal(u).tk === tk0 + q0.reward && Q.state(sid).list[0].have === q0.goal, "второй раз за то же задание не платим");
  for (const q of list.slice(1)) for (let i = 0; i < q.goal; i++) step(q);
  st = Q.state(sid);
  const sum = list.reduce((s, x) => s + x.reward, 0) + QM.ALL_BONUS;
  ok(st.list.every(x => x.done) && st.bonus && bal(u).tk === tk0 + sum, "все три задания + бонус " + QM.ALL_BONUS + " ТК", { tk: bal(u).tk - tk0, sum, st });
  ok(db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind='quest'").get(u.id).n === 4, "в истории 4 начисления за задания");
  // игрок без аккаунта на сайте: награда копится до первого входа
  for (let i = 0; i < q0.goal; i++) step(q0, stranger);
  ok(Math.round(db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(stranger).tk) === q0.reward, "без аккаунта — награда ждёт первого входа");
  // на следующий день — новые задания, прогресс с нуля
  const st2 = Q.state(sid, NOW + 86400e3);
  ok(st2.list.every(x => x.have === 0 && !x.done) && !st2.bonus && st2.day !== st.day, "новый день — новые задания с нуля", st2);
  ok(st.ends > NOW && st.ends - NOW <= 86400e3 && new Date(st.ends + 3 * 3600e3).toISOString().slice(11, 16) === "00:00", "таймер до 00:00 по Москве", new Date(st.ends).toISOString());
  ok(Q.state(null).list.length === 3 && Q.state(null).list.every(x => x.have === 0), "гость видит задания без прогресса");

  // данные для команд в игре
  const sql = INFO.sqlFor([{ sid, n: "Ник'с\\бэкслэшем", tier: "KING", place: 3, pts: 120, k: 40, d: 20, hs: 9, tk: 5000, pending: 12, earn: { base: 340, cap: 2000, mult: 2 }, quests: st },
    { sid: stranger, n: "Гость", tier: "", tk: null, pending: 150, earn: { base: 0, cap: 2000, mult: 1 }, quests: null }, { sid: "123", n: "bad" }],
    [{ sid, n: "Топ1", pts: 120, k: 40, d: 20 }]);
  ok(/INSERT INTO tasher_player .*\(\d{17},'Никсбэкслэшем','KING',3,120,40,20,9,5000,12,340,2000,'2','\{"l":\[/.test(sql) && /,-1,150,0,2000,'1',''\)/.test(sql) && !/\b123,/.test(sql), "игрок для !rank/!tk/!quests: без кавычек, гость с -1", sql.slice(0, 600));
  const js = /'(\{"l":.*?\})'\)/.exec(sql); let parsed = null; try { parsed = JSON.parse(js[1]); } catch (e) {}
  ok(parsed && parsed.l.length === 3 && parsed.l[0].g === list[0].goal && parsed.b === 1 && parsed.bt === QM.ALL_BONUS, "задания для игры — правильный JSON", js && js[1]);
  ok(/INSERT INTO tasher_top \(place,steamid,name,pts,kills,deaths\) VALUES \(1,\d{17},'Топ1',120,40,20\)/.test(sql), "топ-10 для !top");
}

db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nОШИБОК: ${fails}` : "\nТК за игру, Фортуна, джекпот, кланы и стиль работают");
process.exit(fails ? 1 : 0);
