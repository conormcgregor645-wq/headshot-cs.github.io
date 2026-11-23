"use strict";
// Достижения: сервер сам проверяет их по своей статистике и один раз начисляет ТК за каждое выполненное.
// Список совпадает с сайтом (index.html: ACH_METRIC) — сверку делает test/achievements.js.
// Награда — по редкости, как на сайте: обычное 150, редкое 450, эпическое 1 500, легендарное 4 500 ТК.
// Выплата один раз на игрока и достижение (таблица ach_paid); тем, кто ещё не заходил на сайт, — копится до входа.

const RAR = [[50, 150], [20, 450], [5, 1500], [0, 4500]]; // [процент игроков от, ТК]
const tkFor = pct => RAR.find(r => pct >= r[0])[1];

const WG = {
  three: ["Five-SeveN", "Tec-9", "CZ75-Auto"],
  pist: ["Glock-18", "P2000", "USP-S", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "Dual Berettas", "R8 Revolver"],
  rif: ["Galil AR", "FAMAS", "AUG", "SG 553"],
  smg: ["MAC-10", "MP9", "MP7", "MP5-SD", "UMP-45", "P90", "PP-Bizon"],
  sg: ["Nova", "XM1014", "Sawed-Off", "MAG-7"],
  mg: ["Negev", "M249"],
};

// [название, что считаем, цель, процент игроков с достижением]
const DEFS = [
  ["Новобранец", "k", 100, 85],
  ["Боец", "k", 1000, 52],
  ["Опытный стрелок", "k", 5000, 20],
  ["Машина войны", "k", 10000, 9],
  ["Живая легенда", "k", 50000, 1],
  ["Хедшот-машина", "hs", 1000, 14],
  ["Меткий глаз", "hs", 100, 74],
  ["Снайперский инстинкт", "hs", 500, 38],
  ["Мастер хедшотов", "hs", 5000, 5],
  ["Безупречный", "hs", 10000, 2],
  ["Помощник", "a", 100, 60],
  ["Плечом к плечу", "a", 500, 24],
  ["Правая рука", "a", 2000, 4],
  ["Первые шаги", "rp", 100, 82],
  ["Командный игрок", "rp", 1000, 45],
  ["Ветеран раундов", "rp", 5000, 12],
  ["Победитель", "rw", 100, 78],
  ["Чемпион", "rw", 1000, 35],
  ["Непобедимый", "rw", 5000, 9],
  ["Сапёр-новичок", "pl", 10, 70],
  ["Мастер установки", "pl", 100, 31],
  ["Подрывных дел мастер", "pl", 500, 6],
  ["Кусачки", "df", 10, 48],
  ["Мастер разминировки", "df", 50, 17],
  ["Главный сапёр", "df", 200, 5],
  ["Завсегдатай", "h", 10, 80],
  ["Свой человек", "h", 50, 45],
  ["Ветеран", "h", 100, 21],
  ["Старожил", "h", 500, 4],
  ["Часть сервера", "h", 1000, 1],
  ["Золотая лихорадка", "bm", 5000, 55],
  ["Хранитель", "bm", 10000, 30],
  ["Орёл", "bm", 20000, 9],
  ["Высший класс", "bm", 30000, 4],
  ["Калаш", "w=AK-47", 100, 70],
  ["Мастер калаша", "w=AK-47", 1000, 30],
  ["Легенда АК", "w=AK-47", 5000, 7],
  ["Эмка", "w=M4A4", 100, 60],
  ["Глушитель", "w=M4A1-S", 100, 58],
  ["Снайпер", "w=AWP", 300, 18],
  ["Снайпер-ветеран", "w=AWP", 1000, 10],
  ["Глаз бога", "w=AWP", 3000, 3],
  ["Скаут", "w=SSG 08", 50, 25],
  ["Дигл", "w=Desert Eagle", 100, 52],
  ["Король дигла", "w=Desert Eagle", 1000, 12],
  ["Юсп", "w=USP-S", 100, 60],
  ["Мастер USP-S", "w=USP-S", 1000, 14],
  ["Глок", "w=Glock-18", 100, 55],
  ["Ковбой", "w=R8 Revolver", 50, 6],
  ["Финка", "w=Нож", 1, 55],
  ["Ножевик", "w=Нож", 25, 7],
  ["Резник", "w=Нож", 100, 2],
  ["Подрывник", "w=Граната", 10, 35],
  ["Гранатомёт", "w=Граната", 100, 8],
  ["Поджигатель", "w=Молотов", 50, 10],
  ["Обманщик", "w=decoy", 1, 0.8],
  ["Электрик", "w=Zeus x27", 1, 30],
  ["Тройка", "w:three", 100, 26],
  ["Пистолетный король", "w:pist", 500, 22],
  ["Винтовочник", "w:rif", 1000, 12],
  ["Пистолет-пулемётчик", "w:smg", 500, 23],
  ["Дробовик", "w:sg", 250, 11],
  ["Пулемётчик", "w:mg", 100, 4],
  ["Арсенал", "arsenal", 20, 9],
  ["Добро пожаловать", "welcome", 1, 99],
  ["Король месяца", "king", 1, 0.5],
].map(([n, m, t, pct]) => ({ n, m, t, pct, tk: tkFor(pct) }));

function value(m, s) {
  if (m.startsWith("w=")) return s.w[m.slice(2)] || 0;
  if (m.startsWith("w:")) return WG[m.slice(2)].reduce((a, w) => a + (s.w[w] || 0), 0);
  switch (m) {
    case "h": return Math.floor((s.z.pt || 0) / 3600);
    case "bm": return s.bm;
    case "arsenal": return Object.values(s.w).filter(v => v > 0).length;
    case "welcome": return (s.z.pt || 0) > 0 || (s.z.rp || 0) > 0 || (s.z.k || 0) > 0 ? 1 : 0;
    case "king": return s.king ? 1 : 0;
    default: return s.z[m] || 0; // k, hs, a, rp, rw, pl, df
  }
}

function makeAchievements({ db, tx, addMoney, PTS, now = Date.now, log = console }) {
  const qAll = db.prepare("SELECT * FROM gstats WHERE sid=? AND period='all'");
  const qW = db.prepare("SELECT w, k FROM gweapons WHERE sid=?");
  const qBm = db.prepare(`SELECT MAX(${PTS}) v FROM gstats WHERE sid=? AND period!='all'`);
  const qKing = db.prepare("SELECT 1 FROM awards WHERE sid=? AND place=1 LIMIT 1");
  const qPaid = db.prepare("SELECT name FROM ach_paid WHERE sid=?");
  const ins = db.prepare("INSERT INTO ach_paid(sid,name,tk,created_at) VALUES(?,?,?,?) ON CONFLICT(sid,name) DO NOTHING");
  const userBySid = db.prepare("SELECT id FROM users WHERE steamid=?");
  const pend = db.prepare("INSERT INTO earn_pending(sid,tk,updated_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET tk=tk+excluded.tk, updated_at=excluded.updated_at");

  function statsOf(sid) {
    const z = qAll.get(sid); if (!z) return null;
    return { z, w: Object.fromEntries(qW.all(sid).map(r => [r.w, r.k])), bm: (qBm.get(sid) || {}).v || 0, king: !!qKing.get(sid) };
  }

  // проверить игрока и начислить награды за новые выполненные достижения; вернёт [{n, tk}]
  function check(sid) {
    if (!/^\d{17}$/.test(String(sid || ""))) return [];
    const s = statsOf(sid); if (!s) return [];
    const paid = new Set(qPaid.all(sid).map(r => r.name));
    const fresh = DEFS.filter(d => !paid.has(d.n) && value(d.m, s) >= d.t);
    if (!fresh.length) return [];
    const done = [];
    tx(() => {
      const u = userBySid.get(sid), t = now();
      for (const d of fresh) {
        if (!ins.run(sid, d.n, d.tk, t).changes) continue; // уже выплачено (защита от двойной выплаты)
        if (u) addMoney(u.id, "tk", d.tk, "ach", d.n, { what: "Достижение «" + d.n + "»" });
        else pend.run(sid, d.tk, t);
        done.push({ n: d.n, tk: d.tk });
      }
    });
    for (const d of done) log.log(`[ach] ${sid} получил «${d.n}» +${d.tk} ТК`);
    return done;
  }

  // все игроки со статистикой — при запуске сервера (в том числе выплата за уже выполненное)
  function checkAll() {
    let n = 0, tk = 0;
    for (const r of db.prepare("SELECT sid FROM gplayers").all()) for (const d of check(r.sid)) { n++; tk += d.tk; }
    if (n) log.log(`[ach] начислено ${n} достижений на ${tk} ТК`);
    return { n, tk };
  }

  const paid = sid => qPaid.all(String(sid || "")).map(r => r.name);
  return { check, checkAll, paid };
}

module.exports = { makeAchievements, DEFS, tkFor };
