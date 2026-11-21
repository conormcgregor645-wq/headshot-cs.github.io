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
const MK = require("../lib/market");
const SKM = require("../lib/skill");
const EVM = require("../lib/events");
const PM = require("../lib/pass");
const FM = require("../lib/fun");
const G = require("../lib/game");
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
  ok(c.chat === "{green}[ELITE] {lightblue}[WOLF]" && c.name === "lime" && c.score === "ELITE" && c.smoke === "255,107,139", "стиль: статус, клан, цвет ника, дым", c);
  const tab = STYLE.compose({ tier: "KING", tag: "USER", clanTag: "CLAN", pts: 1234 });
  ok(tab.score === "KING" && tab.chat.includes("[USER]") && !tab.score.includes("USER") && !tab.score.includes("CLAN") && !tab.score.includes("1234"), "В Tab только статус; очки Premier отдельно от тега", tab);
  const newcomer = STYLE.compose({ pts: 42 });
  ok(newcomer.score === "" && newcomer.chat === "{grey}[Новенький]", "Новичок: очки не копируются в клановый тег", newcomer);
  const k = STYLE.compose({ tier: "KING", tag: "PRO", clanTag: "WOLF" });
  ok(k.chat === "{gold}[KING] {lime}[PRO]" && k.score === "KING" && k.smoke === "random" && k.name === "gold", "свой тег вместо клана, у KING случайный дым", k);
  const f = STYLE.compose({ tier: null, killFx: "ring", killSnd: "8bit", trailHex: "#ffffff", tracerHex: "#eb4b4b" });
  ok(f.killFx === "ring" && f.killSnd === "8bit" && f.trail === "255,255,255" && f.tracer === "235,75,75" && f.chat === "{grey}[Новенький]" && f.smoke === "", "эффекты: убийство, звук, след гранат, трассеры", f);
  const bad = STYLE.compose({ killFx: "x';DROP", killSnd: "play quit", trailHex: "red", tracerHex: "#12" });
  ok(!bad.killFx && !bad.killSnd && !bad.trail && !bad.tracer, "чужие значения эффектов не проходят", bad);
  ok(/kill_fx,kill_snd,trail,tracer\) VALUES \(\d{17},'\{grey\}\[Новенький\]','','','','ring','8bit','255,255,255','235,75,75'\)/.test(STYLE.sqlFor([{ sid: sidN(2), killFx: "ring", killSnd: "8bit", trailHex: "#ffffff", tracerHex: "#eb4b4b" }], true)), "эффекты пишутся в таблицу плагина");
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
  ok(!/tasher_punish/.test(sql), "старый плагин без таблицы мутов — её не трогаем");
  const ps = INFO.sqlFor([], [], [{ sid, mute: { until: Date.UTC(2026, 10, 20, 12), reason: "Мат'; DROP" }, gag: null }, { sid: stranger, mute: null, gag: { until: 0, reason: "Спам" } }, { sid: "1", mute: { until: 0, reason: "x" } }]);
  ok(/DELETE FROM tasher_punish;/.test(ps) && new RegExp(`\\(${sid},${Date.UTC(2026, 10, 20, 12) / 1000},'Мат; DROP',-1,''\\)`).test(ps) && new RegExp(`\\(${stranger},-1,'',0,'Спам'\\)`).test(ps) && !/\(1,/.test(ps), "муты и геги для игры: срок в секундах, -1 нет, 0 навсегда", ps);
  ok(/DELETE FROM tasher_punish;\nCOMMIT;/.test(INFO.sqlFor([], [], [])), "все наказания сняты — таблица очищается");
}

// ---------- торговая площадка ----------
{
  const logs = [];
  const M = MK.makeMarket({ db, tx: T, addMoney, itemValue: G.itemValue, catOf: w => (G.W.find(x => x.n === w) || {}).c || "", now, log: { log: m => logs.push(m) } });
  const s1 = user(501, 0), b1 = user(502, 10000), b2 = user(503, 5);
  const ak = G.W.find(w => w.n === "AK-47"), sk = ak.skins[0];
  let k = 0; const give = (u, w = "AK-47", s = sk[0], wear = 0.1) => { const id = "mk" + (++k); db.prepare("INSERT INTO items(id,user_id,w,s,r,wear,st,sv,sp,fx,seed,src,src_ref,state,created_at) VALUES(?,?,?,?,?,?,0,0,NULL,0,1,'case','x','inv',?)").run(id, u.id, w, s, 3, wear, NOW); return id; };
  const i1 = give(s1), v = G.itemValue(db.prepare("SELECT * FROM items WHERE id=?").get(i1));
  db.prepare("INSERT INTO loadout(user_id,team,slot,item_id) VALUES(?,?,?,?)").run(s1.id, "t", "AK-47", i1);
  ok(thr(() => M.listItem(s1, i1, 0), /целое/) && thr(() => M.listItem(s1, i1, 1.5), /целое/) && thr(() => M.listItem(s1, i1, MK.maxPrice(v) + 1), /Слишком высокая/), "цена: целая, от 1, не выше трёх цен сайта");
  ok(thr(() => M.listItem(b1, i1, 100), /не найден/), "чужой скин не выставить");
  let r = M.listItem(s1, i1, 1000);
  ok(r.lot.price === 1000 && r.unequipped && db.prepare("SELECT state FROM items WHERE id=?").get(i1).state === "market" && !db.prepare("SELECT 1 FROM loadout WHERE item_id=?").get(i1), "скин выставлен: ушёл из инвентаря и снят с персонажа", r);
  ok(thr(() => M.listItem(s1, i1, 900), /не найден|использован/), "дважды не выставить");
  let B = M.browse(); ok(B.total === 1 && B.lots[0].it.w === "AK-47" && B.lots[0].seller === "U501" && B.lots[0].v === v, "лот на витрине", B);
  ok(M.browse({ q: "ak-4" }).total === 1 && M.browse({ q: "нет" }).total === 0 && M.browse({ cat: "rifle" }).total === 1 && M.browse({ cat: "knife" }).total === 0 && M.browse({ r: "3" }).total === 1 && M.browse({ r: "1" }).total === 0, "поиск и фильтры");
  ok(thr(() => M.buy(s1, B.lots[0].id), /твой лот/), "свой лот не купить");
  ok(thr(() => M.buy(b2, B.lots[0].id), /Не хватает/), "без денег не купить");
  ok(thr(() => M.buy(b1, B.lots[0].id, 999), /изменилась/), "цена изменилась — покупка не проходит");
  const fee = MK.feeOf(1000);
  r = M.buy(b1, B.lots[0].id, 1000);
  ok(fee === 50 && r.tk === 9000 && bal(s1).tk === 950 && db.prepare("SELECT user_id, state FROM items WHERE id=?").get(i1).user_id === b1.id && db.prepare("SELECT state FROM items WHERE id=?").get(i1).state === "inv", "покупка: 1000 ТК, продавцу 950 (комиссия 5%), скин у покупателя", { tk: r.tk, s: bal(s1) });
  ok(thr(() => M.buy(b1, B.lots[0].id), /уже купили/), "дважды не купить");
  ok(M.browse().total === 0, "проданный лот ушёл с витрины");
  const h1 = M.mine(s1).hist[0], h2 = M.mine(b1).hist[0];
  ok(h1.kind === "sold" && h1.got === 950 && h1.fee === 50 && h2.kind === "bought" && h2.got === -1000 && M.feed()[0].price === 1000, "история продавца и покупателя, лента продаж", { h1, h2 });
  ok(db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='market'").get().n === 2, "в журнале операций две записи");
  // покупатель перепродаёт; снятие с продажи
  r = M.listItem(b1, i1, 500); ok(r.lot.price === 500 && !r.unequipped, "купленный скин можно перепродать");
  M.cancel(b1, r.lot.id); ok(db.prepare("SELECT state FROM items WHERE id=?").get(i1).state === "inv" && M.browse().total === 0 && M.mine(b1).open.length === 0, "снят с продажи — вернулся в инвентарь");
  ok(thr(() => M.cancel(b1, r.lot.id), /не найден/) && thr(() => M.cancel(s1, 99999), /не найден/), "снять дважды или чужой — нельзя");
  // лимит лотов
  for (let n = 0; n < MK.MAX_LOTS; n++) M.listItem(s1, give(s1), 10);
  ok(thr(() => M.listItem(s1, give(s1), 10), /не больше 30/), "не больше 30 лотов");
  ok(M.browse().total === 30 && M.browse({ sort: "cheap" }).lots.length === 30 && M.browse({ offset: 29 }).lots.length === 1, "страницы витрины");
  ok(MK.feeOf(1) === 0 && MK.feeOf(10) === 1 && MK.feeOf(100) === 5, "комиссия 5%, на копеечных лотах не больше 1");
}

// ---------- лиги ----------
{
  const K = SKM.makeSkill({ db, now });
  const h = (n, team) => ({ sid: sidN(n), n: "H" + n, team, bot: false }), bot = team => ({ sid: null, n: "Bot", team, bot: true });
  const kill = (a, v, warm = false) => K.apply({ e: "kill", a, v }, warm);
  ok(K.info(sidN(601)).calib && K.info(sidN(601)).sr === SKM.START && K.info(sidN(601)).lg === null, "новичок: калибровка, сила 1000");
  kill(h(601, "ct"), h(602, "t"));
  const a1 = K.info(sidN(601)), b1 = K.info(sidN(602));
  ok(a1.sr === 1006 && b1.sr === 994 && a1.n === 1 && b1.n === 1, "убийство равного: +6 / −6", { a1, b1 });
  kill(h(601, "ct"), h(602, "t"), true); ok(K.info(sidN(601)).n === 1, "разминка не считается");
  kill(h(601, "ct"), h(601, "ct")); ok(K.info(sidN(601)).n === 1, "самоубийство не считается");
  kill(h(601, "ct"), h(603, "ct")); ok(Math.round(K.info(sidN(601)).sr) === 1001 && !db.prepare("SELECT 1 FROM skill WHERE sid=?").get(sidN(603)), "тимкилл −5 убийце, жертве ничего");
  const s0 = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(601)).sr;
  kill(h(601, "ct"), bot("t")); const s1 = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(601)).sr;
  kill(bot("t"), h(601, "ct")); const s2 = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(601)).sr;
  ok(s1 - s0 > 0 && s1 - s0 < 3 && s1 - s2 > 0 && s1 - s2 < 3, "боты дают и отнимают мало", { s0, s1, s2 });
  // сильный против слабого: за слабого мало, за сильного много
  db.prepare("INSERT OR REPLACE INTO skill(sid,sr,n,peak,updated_at) VALUES(?,?,?,?,?)").run(sidN(610), 1500, 100, 1500, NOW);
  db.prepare("INSERT OR REPLACE INTO skill(sid,sr,n,peak,updated_at) VALUES(?,?,?,?,?)").run(sidN(611), 900, 100, 900, NOW);
  kill(h(610, "ct"), h(611, "t")); const strongWin = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(610)).sr - 1500;
  kill(h(611, "t"), h(610, "ct")); const upset = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(611)).sr - (900 - strongWin);
  ok(strongWin > 0 && strongWin < 1.5 && upset > 10, "победа над слабым почти ничего не даёт, над сильным — много", { strongWin, upset });
  K.round([sidN(610)], [sidN(611)]); ok(Math.abs(db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(610)).sr - (1500 + strongWin - upset + 1)) < 1e-6, "раунд: +1 победителям, −1 проигравшим");
  // лиги и калибровка
  const i610 = K.info(sidN(610)); ok(i610.lg === SKM.leagueIdx(i610.sr) && SKM.LEAGUES[i610.lg].n === "Алмаз" && i610.next.n === "Мастер" && i610.next.need === Math.ceil(1550 - db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(610)).sr), "лига и следующая", i610);
  for (let n = 0; n < 45; n++) kill(h(620, "ct"), bot("t"));
  const i620 = K.info(sidN(620)); ok(!i620.calib && i620.lg != null && i620.left === 0, "после 40 событий калибровка закончена", i620);
  ok(SKM.leagueIdx(799) === 0 && SKM.leagueIdx(800) === 1 && SKM.leagueIdx(1100) === 3 && SKM.leagueIdx(1700) === 7 && SKM.leagueIdx(5000) === 7, "границы лиг");
  const bd = K.board(); ok(bd.leagues.length === 8 && bd.leagues.reduce((x, l) => x + l.count, 0) === bd.total && bd.top[0].sid === sidN(610), "таблица лиг: число игроков и сильнейшие", bd);
  const st = STYLE.compose({ league: 3, tier: "VIP" }); ok(st.chat === "{silver}[VIP]", "лига — первым тегом в чате игры", st);
  const r0 = db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(610)).sr;
  K.softReset(0.5); ok(Math.abs(db.prepare("SELECT sr FROM skill WHERE sid=?").get(sidN(610)).sr - (1000 + (r0 - 1000) * 0.5)) < 1e-6, "мягкий сброс сезона: половина пути к 1000");
  ok(K.info(sidN(610)).n <= 20, "после сброса — короткая перекалибровка");
}

// ---------- события по расписанию ----------
{
  const msk = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 3, mi); // время по Москве -> UTC
  let T0 = msk(2026, 11, 20, 20, 30); // пятница 20:30 МСК
  const E = EVM.makeEvents({ db, now: () => T0, enabled: true });
  const paused = EVM.makeEvents({ db, now: () => T0, enabled: false });
  ok(paused.active().length === 0 && paused.upcoming().length === 0 && paused.mult("tk") === 1 && paused.mult("xp") === 1 && paused.mult("quest") === 1, "UPD: события выключены, множители нейтральные");
  const titles = () => E.active().map(a => a.title).sort().join();
  ok(titles() === "Пятница заданий,Счастливый час" && E.mult("tk") === 2 && E.mult("quest") === 2 && E.mult("xp") === 1, "пятница 20:30: счастливый час и пятница заданий", E.active());
  const hap = E.active().find(a => a.title === "Счастливый час"); ok(hap.to === msk(2026, 11, 20, 21), "счастливый час до 21:00", new Date(hap.to).toISOString());
  T0 = msk(2026, 11, 20, 21, 0); ok(E.mult("tk") === 1, "в 21:00 закончился");
  T0 = msk(2026, 11, 21, 0, 0); ok(E.mult("quest") === 1 && E.mult("xp") === 2, "суббота 00:00: пятница кончилась, выходные опыта начались");
  T0 = msk(2026, 11, 22, 23, 59); ok(E.mult("xp") === 2, "воскресенье 23:59 ещё выходные");
  T0 = msk(2026, 11, 23, 0, 0); ok(E.mult("xp") === 1, "понедельник — выходные кончились");
  const up = E.upcoming(); ok(up[0].title === "Счастливый час" && up[0].from === msk(2026, 11, 23, 20), "ближайшее — счастливый час в 20:00", up.slice(0, 2));
  // через полночь и разовые
  const adm = { id: 1, name: "Owner" };
  ok(E.create(adm, { kind: "nope", title: "x" }).error && E.create(adm, { kind: "tk2", title: "Ночь", days: [], start: "23:00", end: "02:00" }).error && E.create(adm, { kind: "tk2", title: "Ночь", days: [1], start: "25:00", end: "02:00" }).error, "неверные события отклоняются");
  const n1 = E.create(adm, { kind: "tk2", title: "Ночные ТК", days: [1], start: "23:00", end: "02:00" }); ok(n1.id && !n1.error, "событие через полночь создано", n1);
  T0 = msk(2026, 11, 24, 1, 30); ok(E.mult("tk") === 2 && E.active()[0].to === msk(2026, 11, 24, 2), "вторник 01:30 — ещё понедельничная ночь", E.active());
  T0 = msk(2026, 11, 24, 2, 0); ok(E.mult("tk") === 1, "в 02:00 ночь кончилась");
  const o = E.create(adm, { kind: "xp2", title: "Новый год", once: true, from: msk(2026, 12, 31, 18), to: msk(2027, 1, 2, 0) }); ok(o.id, "разовое событие", o);
  T0 = msk(2027, 1, 1, 12); ok(E.mult("xp") === 2 && E.active().some(a => a.title === "Новый год"), "разовое идёт");
  ok(E.toggle(o.id, false).events.find(x => x.id === o.id).enabled === false && E.mult("xp") === 1, "выключенное событие не действует");
  ok(E.remove(o.id).events.every(x => x.id !== o.id) && E.remove(o.id).code === 404, "удаление");
  ok(E.list().some(x => x.desc === "пн 23:00–02:00 МСК") && E.list().some(x => x.desc === "сб, вс 00:00–00:00 МСК" || /сб, вс 00:00–24:00|сб, вс/.test(x.desc)), "описание расписания", E.list().map(x => x.desc));
  // влияние на ТК и задания
  T0 = msk(2026, 11, 20, 20, 30);
  const E2 = makeEarn({ db, tx: T, addMoney, statusOf: () => null, eventMult: t => E.mult("tk", t), now: () => T0 });
  const before = (db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(sidN(701)) || { tk: 0 }).tk;
  E2.add(sidN(701), 10, T0); ok((db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(sidN(701)).tk - before) === 20 && E2.today(sidN(701), T0).mult === 2, "счастливый час: ТК за игру ×2");
  const Q2 = QM.makeQuests({ db, tx: T, addMoney, eventMult: t => E.mult("quest", t), now: () => T0, log: { error() {} } });
  const st2 = Q2.state(null); ok(st2.x === 2 && st2.list.every((q, i) => q.reward === QM.forDay(QM.mskDay(T0))[i].reward * 2) && st2.bonusTk === 600, "пятница заданий: награды ×2 видны", st2);
}

// ---------- боевой пропуск ----------
{
  let T1 = Date.UTC(2026, 10, 20, 12); let xpm = 1; const grants = []; let ong = 0;
  const COS = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "cosmetics.json"), "utf8")).map(x => [x.id, x]));
  const gi = (uid, it, src, ref) => { db.prepare("INSERT INTO items(id,user_id,w,s,r,wear,st,sv,sp,fx,seed,src,src_ref,state,created_at) VALUES(?,?,?,?,?,?,0,0,NULL,0,?,?,?,'inv',?)").run(it.id, uid, it.w, it.s, it.r, it.wear, it.seed || 0, src, ref || null, T1); return it; };
  const P = PM.makePass({ db, tx: T, addMoney, giveItem: gi, rollCase: G.rollCase, caseByK: k => G.CASE_BY_K.get(k), cosById: id => COS.get(id), addGrant: (...a) => grants.push(a), onGrant: () => ong++, eventMult: () => xpm, now: () => T1, log: { log() {} } });
  ok(PM.REWARDS.free[2][0].id === "bd_skull" && PM.REWARDS.free[11][0].id === "bd_bolt" && PM.REWARDS.prem[27][0].id === "kl_conf", "UPD: в пропуске есть новые оформления между ключевыми уровнями");
  ok(PM.REWARDS.free.length === 50 && PM.REWARDS.prem.length === 50 && [...PM.REWARDS.free, ...PM.REWARDS.prem].flat().every(r => r.t === "tk" ? r.v > 0 : r.t === "case" ? !!G.CASE_BY_K.get(r.k) : r.t === "cos" ? COS.has(r.id) : r.t === "status" ? ["VIP", "PREMIUM", "ELITE", "LEGEND", "TITAN", "KING"].includes(r.tier) && r.d > 0 : false), "50 уровней: все награды существуют (кейсы, оформление, статусы)");
  const u = user(801, 0, 1000), sid = u.steamid;
  ok(P.season().id === "s1" && P.state(sid).me.lv === 0, "идёт сезон 1");
  const k = (a, v, hs) => ({ t: T1, e: "kill", a: { sid: a, team: "ct" }, v: v ? { sid: v, team: "t" } : { sid: null, bot: true, team: "t" }, w: "ak47", hs });
  P.apply(k(sid, sidN(899), true), false); ok(P.state(sid).me.xp === 13, "убийство с хедшотом 13 опыта");
  P.apply(k(sid, null, true), false); ok(P.state(sid).me.xp === 15, "бот — 2 опыта (без бонуса за хедшот)");
  P.apply(k(sid, sidN(899)), true); ok(P.state(sid).me.xp === 15, "разминка не считается");
  for (let i = 0; i < 400; i++) P.minute([sid], T1);
  ok(P.state(sid).me.today === PM.DAY_CAP && P.state(sid).me.xp === PM.DAY_CAP, "лимит опыта за игру — 1500 в сутки", P.state(sid).me);
  P.quest(sid, "hard", T1); ok(P.state(sid).me.xp === PM.DAY_CAP + 500, "задания — сверх лимита");
  xpm = 2; T1 += 86400e3; P.minute([sid], T1); xpm = 1; ok(P.state(sid).me.xp === PM.DAY_CAP + 510, "новый день, выходные опыта ×2");
  ok(P.state(sid).me.lv === 1 && thr(() => P.claim(u, { track: "f", lv: 2 }), /Нужен уровень 2/), "2010 опыта — уровень 1; награду выше уровня не забрать");
  db.prepare("UPDATE pass SET xp=? WHERE sid=?").run(5 * PM.XP_LEVEL + 10, sid);
  let st = P.state(sid); ok(st.me.lv === 5 && st.me.unclaimed === 5 && st.me.into === 10, "уровень 5, 5 бесплатных наград ждут", st.me);
  ok(thr(() => P.claim(u, { track: "p", lv: 1 }), /премиум/), "премиум-награду без премиума не забрать");
  const tk0 = bal(u).tk;
  let r = P.claim(u, { track: "f", lv: 1 }); ok(r.got[0].txt === "110 ТК" && bal(u).tk === tk0 + 110, "забрал уровень 1: 110 ТК", r);
  ok(thr(() => P.claim(u, { track: "f", lv: 1 }), /Уже получено/), "дважды не забрать");
  r = P.claim(u, { all: true }); ok(r.got.length === 4 && r.got.some(g => g.lv === 5 && /кейс «Армейский»/.test(g.txt)) && db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND src='pass'").get(u.id).n === 1, "«Забрать всё»: ТК и скин из кейса", r.got);
  ok(P.state(sid).me.unclaimed === 0, "всё получено");
  r = P.buyPremium(u); ok(r.balance === 1000 - PM.PREMIUM_PRICE && P.state(sid).me.prem && P.state(sid).me.unclaimed === 5, "премиум куплен — открылись премиум-награды пройденных уровней", P.state(sid).me);
  ok(thr(() => P.buyPremium(u), /уже куплен/), "дважды не купить");
  r = P.claim(u, { all: true }); ok(r.got.length === 5 && r.got.some(g => g.track === "p" && /кейс «Огненный»/.test(g.txt)), "премиум-награды получены", r.got);
  // статус и оформление
  db.prepare("UPDATE pass SET xp=? WHERE sid=?").run(50 * PM.XP_LEVEL + 9999, sid);
  ok(P.state(sid).me.lv === 50, "уровень не выше 50");
  db.prepare("INSERT INTO cos_own(user_id,item_id,created_at) VALUES(?,?,?)").run(u.id, "fr_winter", T1);
  const t1 = bal(u).tk; ong = 0; grants.length = 0;
  r = P.claim(u, { track: "p", lv: 50 });
  ok(grants.length === 1 && grants[0][1] === "KING" && grants[0][2] === 14 && ong === 1 && r.got.some(g => /2490 ТК вместо «Зима 2026»/.test(g.txt)) && bal(u).tk === t1 + 2490, "уровень 50: KING на 14 дней, уже купленная рамка — ТК", r.got);
  r = P.claim(u, { track: "f", lv: 10 }); ok(db.prepare("SELECT 1 FROM cos_own WHERE user_id=? AND item_id='bd_aim'").get(u.id) && r.got[0].txt === "«Прицел»", "оформление из пропуска — в «Моих вещах»");
  const b = P.brief(sid); ok(b.lv === 50 && b.prem === 1 && b.s === "Сезон 1 · Зима" && b.un > 0, "данные для !pass", b);
  T1 = Date.UTC(2027, 1, 5); ok(P.state(sid).season === null && P.addXp(sid, 100, T1) === 0 && thr(() => P.claim(u, { all: true }), /закончился/), "после конца сезона опыт и награды закрыты");
}

// ---------- игровые бонусы: первая кровь, эйс, особые раунды ----------
{
  console.log("Игровые бонусы");
  const said = [], xps = [], pend = sid => (db.prepare("SELECT tk FROM earn_pending WHERE sid=?").get(sid) || {}).tk || 0;
  let T2 = Date.UTC(2026, 10, 21, 12), mult = 1, team = [];
  const F = FM.makeFun({ db, tx: T, addMoney, addXp: (sid, v) => xps.push([sid, v]), eventMult: () => mult, inGame: () => team, say: m => said.push(m), now: () => T2, log: { log() {}, error() {} } });
  const u = user(9101), hs = sidN(9101), other = sidN(9102), third = sidN(9103);
  const P = (sid, n, tm, uid) => ({ n, uid, sid, bot: false, team: tm }), B = (n, tm, uid) => ({ n, uid, sid: null, bot: true, team: tm });
  const me = P(hs, "Хантер", "ct", 2), en = P(other, "Враг", "t", 3), en2 = P(third, "Враг2", "t", 4), bot = i => B("Bot" + i, "t", 10 + i);
  const kill = (a, v, dt = 1000) => { T2 += dt; F.apply({ t: T2, e: "kill", a, v, w: "ak47", hs: false }, false); };
  const rs = () => F.apply({ t: T2, e: "round_start" }, false);
  const tk0 = () => bal(u).tk;
  let b0 = tk0();
  rs(); kill(me, en); ok(tk0() === b0 + 20, "первая кровь по игроку: +20 ТК", tk0() - b0);
  kill(me, bot(1)); ok(tk0() === b0 + 20, "второе убийство — не первая кровь");
  rs(); b0 = tk0(); kill(me, bot(2)); ok(tk0() === b0 + 5, "первая кровь по боту: +5 ТК", tk0() - b0);
  rs(); b0 = tk0(); kill(en, me); ok(tk0() === b0 && pend(other) === 20, "первая кровь у незарегистрированного — копится", pend(other));
  // эйс: среди убитых 2 игрока — 100 ТК, молча (в чат ничего)
  rs(); b0 = tk0(); said.length = 0; xps.length = 0;
  kill(en, B("BotC", "ct", 9));
  kill(me, en); kill(me, en2); kill(me, bot(4)); kill(me, bot(5));
  ok(tk0() === b0, "до пятого убийства эйса нет");
  kill(me, bot(6));
  ok(tk0() === b0 + 100 && xps.some(x => x[0] === hs && x[1] === 100) && !said.length, "эйс: +100 ТК и +100 опыта, без сообщений в чат", { d: tk0() - b0, said });
  rs(); b0 = tk0(); for (let i = 0; i < 5; i++) kill(me, bot(20 + i));
  ok(tk0() === b0 + 5 + 30, "эйс по одним ботам: 30 ТК (+5 первая кровь)", tk0() - b0);
  // тимкилл и самоубийство не считаются
  rs(); const p1 = pend(third); kill(en2, en); ok(pend(third) === p1, "тимкилл — не первая кровь");
  rs(); b0 = tk0(); kill(me, me); kill(me, en); ok(tk0() === b0 + 20, "самоубийство — не первая кровь");
  // разминка не считается
  rs(); b0 = tk0(); F.apply({ t: T2 += 1000, e: "kill", a: me, v: en, w: "ak47" }, true); ok(tk0() === b0, "в разминке бонусов нет");
  // особый раунд: победителям по 50 ТК и 30 опыта
  team = [[hs, "ct"], [other, "t"], [third, "ct"]]; said.length = 0; xps.length = 0; b0 = tk0(); const p2 = pend(third), po = pend(other);
  ok(F.marker("TASHERFUN special_win wh ct", T2 += 60e3) && tk0() === b0 + 50 && pend(third) === p2 + 50 && pend(other) === po, "особый раунд «Все с ВХ»: +50 ТК победившей команде", tk0() - b0);
  ok(said.some(m => /Особый раунд «Все с ВХ» выиграл спецназ: \+50 ТК каждому/.test(m)) && xps.filter(x => x[1] === 30).length === 2, "объявление и опыт за особый раунд", said);
  ok(F.marker("TASHERFUN special_win wh ct", T2 + 5e3) === null, "повтор в том же раунде не платит");
  ok(F.marker("TASHERFUN special_win rm_rf ct", T2 + 60e3) === null && F.marker("TASHERFUN special_win knife x", T2 + 90e3) === null && F.marker("xTASHERFUN special_win knife ct", T2 + 120e3) === null, "чужие строки не принимаются");
  ok(F.marker("TASHERFUN special_win awp t", T2 + 200e3, true) === null, "в разминке не платит");
  ok(["invis", "hs", "bhop", "vampire", "ammo"].every(k => FM.MODES[k]) && Object.keys(FM.MODES).length === 13, "все 13 режимов известны сайту");
  // «Счастливый час» ×2 и дневной лимит
  mult = 2; rs(); b0 = tk0(); kill(me, en);
  ok(tk0() === b0 + 40, "первая кровь в «Счастливый час» ×2", tk0() - b0);
  db.prepare("UPDATE fun_day SET tk=? WHERE sid=?").run(FM.DAY_CAP - 10, hs);
  rs(); b0 = tk0(); kill(me, en); ok(tk0() === b0 + 20, "упёрлись в лимит: начислено только до лимита (10 × 2)", tk0() - b0);
  rs(); b0 = tk0(); kill(me, en); ok(tk0() === b0, "после лимита — ничего");
  const led = db.prepare("SELECT meta FROM ledger WHERE user_id=? AND kind='fun'").all(u.id).map(r => JSON.parse(r.meta).what);
  ok(led.includes("Первая кровь в раунде") && led.includes("Эйс: 5 убийств за раунд") && led.includes("Победа в особом раунде «Все с ВХ»"), "история счёта: понятные записи", led);
  ok(!("bounties" in F) && !("bounty" in F.info()), "награды за голову нет");
}

db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nОШИБОК: ${fails}` : "\nТК за игру, Фортуна, джекпот, кланы и стиль работают");
process.exit(fails ? 1 : 0);
