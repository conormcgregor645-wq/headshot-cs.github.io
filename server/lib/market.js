"use strict";
// Торговая площадка: игроки продают скины друг другу за ТК. Сайт берёт комиссию 5% с продавца.
// Выставленный скин уходит из инвентаря (state='market') и не может участвовать в апгрейде, джекпоте или продаже сайту.
// Продажа сайту (в инвентаре) остаётся как была — по цене скина, без комиссии.

const FEE = 0.05;
const MAX_LOTS = 30;           // открытых лотов у одного игрока
const PAGE = 48;
const feeOf = price => (price >= 2 ? Math.max(1, Math.round(price * FEE)) : 0);
// цена лота: от 1 ТК до трёх цен сайта (но не меньше 100 ТК) — защита от опечаток
const maxPrice = v => Math.max(100, Math.round(v * 3));

function makeMarket({ db, tx, addMoney, itemValue, catOf, now = Date.now, log = console }) {
  const lotQ = db.prepare(`SELECT m.*, i.w, i.s, i.r, i.wear, i.st, i.sv, i.sp, i.fx, i.seed, i.user_id owner, i.state istate, u.name seller
    FROM market m JOIN items i ON i.id=m.item_id JOIN users u ON u.id=m.seller_id WHERE m.id=?`);
  const pubLot = r => ({ id: r.id, price: r.price, t: r.created_at, seller: r.seller || "Игрок", sid: r.seller_id,
    it: { id: r.item_id, w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, fx: r.fx || undefined, seed: r.seed }, v: Math.max(1, itemValue(r)) });

  function listItem(u, itemId, priceRaw) {
    const price = Number(priceRaw);
    if (typeof itemId !== "string" || itemId.length > 40) { const e = new Error("Неверный предмет"); e.code = 400; throw e; }
    return tx(() => {
      const it = db.prepare("SELECT * FROM items WHERE id=? AND user_id=? AND state='inv'").get(itemId, u.id);
      if (!it) throw Object.assign(new Error("Предмет не найден или уже использован"), { code: 409 });
      const v = Math.max(1, itemValue(it));
      if (!Number.isInteger(price) || price < 1) throw Object.assign(new Error("Цена — целое число ТК, от 1"), { code: 400 });
      if (price > maxPrice(v)) throw Object.assign(new Error(`Слишком высокая цена: не больше ${maxPrice(v).toLocaleString("ru-RU")} ТК для этого скина`), { code: 400 });
      const n = db.prepare("SELECT COUNT(*) n FROM market WHERE seller_id=? AND state='open'").get(u.id).n;
      if (n >= MAX_LOTS) throw Object.assign(new Error(`Можно выставить не больше ${MAX_LOTS} скинов одновременно`), { code: 409 });
      db.prepare("UPDATE items SET state='market', closed_at=? WHERE id=?").run(now(), it.id);
      const unequipped = db.prepare("DELETE FROM loadout WHERE item_id=?").run(it.id).changes > 0;
      const id = db.prepare("INSERT INTO market(item_id,seller_id,price,state,created_at) VALUES(?,?,?,'open',?)").run(it.id, u.id, price, now()).lastInsertRowid;
      return { lot: pubLot(lotQ.get(id)), unequipped };
    });
  }

  function cancel(u, lotId) {
    return tx(() => {
      const m = db.prepare("SELECT * FROM market WHERE id=? AND seller_id=? AND state='open'").get(Number(lotId) | 0, u.id);
      if (!m) throw Object.assign(new Error("Лот не найден или уже продан"), { code: 404 });
      db.prepare("UPDATE market SET state='cancelled', closed_at=? WHERE id=?").run(now(), m.id);
      db.prepare("UPDATE items SET state='inv', closed_at=NULL WHERE id=? AND state='market'").run(m.item_id);
      return { ok: true, itemId: m.item_id };
    });
  }

  function buy(u, lotId, expectPrice) {
    return tx(() => {
      const m = lotQ.get(Number(lotId) | 0);
      if (!m || m.state !== "open" || m.istate !== "market") throw Object.assign(new Error("Этот скин уже купили или сняли с продажи"), { code: 409 });
      if (m.seller_id === u.id) throw Object.assign(new Error("Это твой лот — его можно только снять с продажи"), { code: 409 });
      if (expectPrice != null && Number(expectPrice) !== m.price) throw Object.assign(new Error("Цена лота изменилась — обнови страницу"), { code: 409 });
      const fee = feeOf(m.price), name = `${m.w} | ${m.s}`;
      const tk = addMoney(u.id, "tk", -m.price, "market", "buy:" + m.id, { what: `Площадка: покупка ${name}` });
      addMoney(m.seller_id, "tk", m.price - fee, "market", "sell:" + m.id, { what: `Площадка: продажа ${name}`, fee });
      db.prepare("UPDATE items SET user_id=?, state='inv', closed_at=NULL, src='market', src_ref=? WHERE id=?").run(u.id, String(m.id), m.item_id);
      db.prepare("DELETE FROM loadout WHERE item_id=?").run(m.item_id);
      db.prepare("UPDATE market SET state='sold', buyer_id=?, fee=?, closed_at=? WHERE id=?").run(u.id, fee, now(), m.id);
      log.log(`[market] ${u.name || u.id} купил ${name} у ${m.seller} за ${m.price} ТК (комиссия ${fee})`);
      return { tk, item: pubLot(m).it, price: m.price, sellerId: m.seller_id };
    });
  }

  // витрина: фильтры и сортировка в JS (имена скинов бывают кириллицей — SQLite LIKE её не сравнивает без учёта регистра)
  function browse({ q = "", cat = "", r = "", sort = "new", offset = 0 } = {}) {
    const rows = db.prepare(`SELECT m.*, i.w, i.s, i.r, i.wear, i.st, i.sv, i.sp, i.fx, i.seed, u.name seller
      FROM market m JOIN items i ON i.id=m.item_id AND i.state='market' JOIN users u ON u.id=m.seller_id WHERE m.state='open' ORDER BY m.id DESC LIMIT 5000`).all();
    const ql = String(q).toLowerCase().trim().slice(0, 60), rr = r === "" || r == null ? null : Number(r);
    let list = rows.filter(x => (!ql || `${x.w} | ${x.s}`.toLowerCase().includes(ql)) && (!cat || catOf(x.w) === cat) && (rr == null || x.r === rr));
    const cmp = { cheap: (a, b) => a.price - b.price || b.id - a.id, exp: (a, b) => b.price - a.price || b.id - a.id, deal: (a, b) => a.price / Math.max(1, itemValue(a)) - b.price / Math.max(1, itemValue(b)) || b.id - a.id, new: (a, b) => b.id - a.id }[sort] || ((a, b) => b.id - a.id);
    list.sort(cmp);
    const off = Math.max(0, Math.min(Number(offset) | 0, 100000));
    return { total: list.length, lots: list.slice(off, off + PAGE).map(pubLot), page: PAGE, all: rows.length };
  }

  function mine(u) {
    const open = db.prepare(`SELECT m.*, i.w, i.s, i.r, i.wear, i.st, i.sv, i.sp, i.fx, i.seed, u.name seller FROM market m JOIN items i ON i.id=m.item_id JOIN users u ON u.id=m.seller_id
      WHERE m.seller_id=? AND m.state='open' ORDER BY m.id DESC`).all(u.id).map(pubLot);
    const hist = db.prepare(`SELECT m.id, m.price, m.fee, m.state, m.closed_at, m.seller_id, m.buyer_id, i.w, i.s, i.r, i.wear, i.st, i.sv, i.sp, i.fx, i.seed, i.id item_id
      FROM market m JOIN items i ON i.id=m.item_id WHERE (m.seller_id=? OR m.buyer_id=?) AND m.state='sold' ORDER BY m.closed_at DESC LIMIT 50`).all(u.id, u.id)
      .map(r => ({ id: r.id, kind: r.seller_id === u.id ? "sold" : "bought", price: r.price, fee: r.seller_id === u.id ? r.fee : 0, got: r.seller_id === u.id ? r.price - r.fee : -r.price, t: r.closed_at,
        it: { id: r.item_id, w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, fx: r.fx || undefined, seed: r.seed } }));
    return { open, hist, max: MAX_LOTS };
  }

  // последние продажи (лента на витрине)
  function feed() {
    return db.prepare(`SELECT m.id, m.price, m.closed_at, i.w, i.s, i.r, i.wear, i.st, i.sv, i.sp, i.fx, i.seed, i.id item_id FROM market m JOIN items i ON i.id=m.item_id
      WHERE m.state='sold' ORDER BY m.closed_at DESC LIMIT 12`).all()
      .map(r => ({ id: r.id, price: r.price, t: r.closed_at, it: { id: r.item_id, w: r.w, s: r.s, r: r.r, wear: r.wear, st: !!r.st, sv: !!r.sv, sp: r.sp || undefined, fx: r.fx || undefined, seed: r.seed } }));
  }

  return { listItem, cancel, buy, browse, mine, feed, FEE, MAX_LOTS };
}

module.exports = { makeMarket, feeOf, maxPrice, FEE, MAX_LOTS };
