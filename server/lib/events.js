"use strict";
// События по расписанию (время московское): «Счастливый час» — ТК за игру ×2, «Выходные опыта» — опыт пропуска ×2,
// «Пятница заданий» — награды за задания ×2. Еженедельные (дни недели + время) и разовые (с даты по дату).
// Сайт сам включает и выключает их, показывает баннер и объявляет в чате игры.

const KINDS = {
  tk2: { n: "ТК за игру ×2", what: "tk", m: 2 },
  xp2: { n: "Опыт пропуска ×2", what: "xp", m: 2 },
  quest2: { n: "Награды за задания ×2", what: "quest", m: 2 },
};
const MSK = 3 * 3600e3, DAY = 864e5;
const DAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const hm = s => { const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(String(s || "")); if (!m) return null; const v = +m[1] * 60 + +m[2]; return v <= 1440 ? v : null; };
const hmStr = v => (v === 1440 ? "24:00" : `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`);
// начало суток по Москве (UTC-время)
const dayStart = t => { const d = new Date(t + MSK); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MSK; };

// все интервалы события, которые пересекают [from, to)
function windows(e, from, to) {
  if (e.once) return e.from < to && e.to > from ? [[e.from, e.to]] : [];
  const out = [], days = new Set(e.days), s = e.start, en = e.end > e.start ? e.end : e.end + 1440;
  for (let d = dayStart(from) - DAY; d < to; d += DAY) {
    const wd = new Date(d + MSK).getUTCDay();
    if (!days.has(wd)) continue;
    const a = d + s * 60e3, b = d + en * 60e3;
    if (a < to && b > from) out.push([a, b]);
  }
  return out;
}

function makeEvents({ db, now = Date.now }) {
  const rows = () => db.prepare("SELECT * FROM events WHERE enabled=1 ORDER BY id").all().map(parse);
  function parse(r) {
    return { id: r.id, kind: r.kind, title: r.title, once: !!r.once, days: r.days ? r.days.split(",").map(Number) : [], start: r.start_min, end: r.end_min, from: r.from_at, to: r.to_at, enabled: !!r.enabled };
  }
  const pub = (e, w) => ({ id: e.id, kind: e.kind, title: e.title, what: KINDS[e.kind].n, m: KINDS[e.kind].m, from: w[0], to: w[1] });
  // что идёт прямо сейчас
  function active(t = now()) {
    const out = [];
    for (const e of rows()) { if (!KINDS[e.kind]) continue; const w = windows(e, t, t + 1).find(x => x[0] <= t && x[1] > t); if (w) out.push(pub(e, w)); }
    return out;
  }
  // множитель для tk / xp / quest (одинаковые события не складываются — берём самый большой)
  function mult(what, t = now()) { let m = 1; for (const a of active(t)) if (KINDS[a.kind].what === what) m = Math.max(m, a.m); return m; }
  // ближайшие начала (на неделю вперёд), без уже идущих
  function upcoming(t = now(), limit = 6) {
    const out = [];
    for (const e of rows()) { if (!KINDS[e.kind]) continue; for (const w of windows(e, t, t + 8 * DAY)) if (w[0] > t) out.push(pub(e, w)); }
    return out.sort((a, b) => a.from - b.from).slice(0, limit);
  }
  function state(t = now()) { return { active: active(t), upcoming: upcoming(t), now: t }; }

  // ---------- админка ----------
  const desc = e => e.once ? `разово: ${new Date(e.from + MSK).toISOString().slice(0, 16).replace("T", " ")} — ${new Date(e.to + MSK).toISOString().slice(0, 16).replace("T", " ")} МСК`
    : `${e.days.length === 7 ? "каждый день" : e.days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => DAYS_RU[d]).join(", ")} ${hmStr(e.start)}–${hmStr(e.end)} МСК`;
  function list() {
    return db.prepare("SELECT * FROM events ORDER BY id").all().map(parse).map(e => ({ ...e, what: KINDS[e.kind] ? KINDS[e.kind].n : e.kind, desc: desc(e) }));
  }
  function create(admin, b) {
    const kind = String(b.kind || ""); if (!KINDS[kind]) return { error: "Неизвестный тип события" };
    const title = String(b.title || "").replace(/[\u0000-\u001f"';\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (title.length < 3) return { error: "Название — от 3 символов" };
    if (b.once) {
      const from = Number(b.from), to = Number(b.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { error: "Конец должен быть позже начала" };
      if (to - from > 14 * DAY) return { error: "Разовое событие — не дольше 14 дней" };
      if (to < now()) return { error: "Это время уже прошло" };
      const id = db.prepare("INSERT INTO events(kind,title,once,days,start_min,end_min,from_at,to_at,enabled,created_by,created_at) VALUES(?,?,1,'',0,0,?,?,1,?,?)").run(kind, title, Math.round(from), Math.round(to), admin.name || "", now()).lastInsertRowid;
      return { id, events: list() };
    }
    const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    if (!days.length) return { error: "Выбери дни недели" };
    const s = hm(b.start), e = hm(b.end);
    if (s == null || e == null || s === 1440) return { error: "Время в формате ЧЧ:ММ" };
    if (s === e) return { error: "Начало и конец совпадают" };
    const id = db.prepare("INSERT INTO events(kind,title,once,days,start_min,end_min,from_at,to_at,enabled,created_by,created_at) VALUES(?,?,0,?,?,?,0,0,1,?,?)").run(kind, title, days.join(","), s, e, admin.name || "", now()).lastInsertRowid;
    return { id, events: list() };
  }
  function toggle(id, on) { const r = db.prepare("UPDATE events SET enabled=? WHERE id=?").run(on ? 1 : 0, Number(id) | 0); return r.changes ? { events: list() } : { error: "Событие не найдено", code: 404 }; }
  function remove(id) { const r = db.prepare("DELETE FROM events WHERE id=?").run(Number(id) | 0); return r.changes ? { events: list() } : { error: "Событие не найдено", code: 404 }; }
  return { active, mult, upcoming, state, list, create, toggle, remove, KINDS };
}

module.exports = { makeEvents, KINDS, windows, hmStr };
