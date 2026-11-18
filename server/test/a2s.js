"use strict";
// Проверка опроса игрового сервера: node test/a2s.js (поднимает поддельный сервер CS2 на UDP)
const dgram = require("node:dgram");
const A2S = require("../lib/a2s");
let fails = 0; const ok = (c, n, x) => { if (!c) fails++; console.log((c ? "  ok  " : "FAIL  ") + n + (c ? "" : " " + JSON.stringify(x))); };
const CH = Buffer.from([1, 2, 3, 4]), H = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const z = s => Buffer.from(s + "\0", "utf8");
const srv = dgram.createSocket("udp4");
srv.on("message", (m, r) => {
  const send = b => srv.send(Buffer.concat([H, b]), r.port, r.address);
  if (m[4] === 0x54) {
    if (!m.subarray(-4).equals(CH)) return send(Buffer.concat([Buffer.from([0x41]), CH])); // сначала «вызов», как у CS2
    const sh = Buffer.alloc(2); sh.writeInt16LE(730);
    return send(Buffer.concat([Buffer.from([0x49, 17]), z("TASHER | Public 5x5"), z("de_dust2"), z("csgo"), z("Counter-Strike 2"), sh, Buffer.from([4, 10, 1, 100, 108, 0, 1]), z("1.41.0.0")]));
  }
  if (m[4] === 0x55) {
    if (!m.subarray(5, 9).equals(CH)) return send(Buffer.concat([Buffer.from([0x41]), CH]));
    const pl = [["Kexa", 21, 1834.5], ["Игрок<b>", 7, 60.2], ["", 0, 3]];
    const parts = [Buffer.from([0x44, pl.length])];
    for (const [n, s, t] of pl) { const sc = Buffer.alloc(4); sc.writeInt32LE(s); const tm = Buffer.alloc(4); tm.writeFloatLE(t); parts.push(Buffer.from([0]), z(n), sc, tm); }
    return send(Buffer.concat(parts));
  }
});
srv.bind(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  const L = A2S.parse(`TASHER|81.90.183.178:27015|127.0.0.1:${port};Мёртвый|1.2.3.4:27016|127.0.0.1:9;bad`);
  ok(L.length === 2 && L[0].addr === "81.90.183.178:27015" && L[0].port === port, "настройка GAME_SERVERS разбирается", L);
  const r = await A2S.poll(L, 800);
  ok(r[0].online && r[0].name === "TASHER | Public 5x5" && r[0].map === "de_dust2" && r[0].players === 3 && r[0].bots === 1 && r[0].max === 10, "сервер опрошен: название, карта, игроки без ботов", r[0]);
  ok(r[0].list.length === 2 && r[0].list[0].n === "Kexa" && r[0].list[0].s === 21 && r[0].list[0].t === 1835 && r[0].list[1].n === "Игрок<b>", "список игроков: ник, счёт, время", r[0].list);
  ok(!r[1].online && r[1].players === 0 && r[1].name === "Мёртвый", "недоступный сервер помечен офлайн", r[1]);
  // RCON: поддельный сервер с ответом на status в формате CS2
  const net = require("node:net"), RCON = require("../lib/rcon");
  const STATUS = "Server:  Running [0.0.0.0:27015]\nPlayers:\n---------players--------\n  id     time ping loss      state   rate adr name\n65535 [NoChan]    0    0 challenging      0unknown ''\n    2    02:33   21    0     active 786432 109.1.2.3:27005 'Kexa'\n    3  1:05:07   40    0     active 786432 95.1.2.3:27005 'Ник с пробелом'\n    1      BOT    0    0     active      0 'Ted'\n    4    00:05   99    0 connecting 786432 1.1.1.1:27005 'Входит'\n#end\n";
  const pk = (id, type, body) => { const b = Buffer.from(body, "utf8"), p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p; };
  const rs = net.createServer(c => { let buf = Buffer.alloc(0); c.on("data", d => { buf = Buffer.concat([buf, d]); while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) { const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString("utf8", 12, 4 + len - 2); buf = buf.subarray(4 + len);
    if (type === 3) { c.write(pk(id, 0, "")); c.write(pk(body === "secret" ? id : -1, 2, "")); }
    else if (type === 2 && body === "status") { c.write(pk(id, 0, STATUS.slice(0, 120))); setTimeout(() => c.write(pk(id, 0, STATUS.slice(120))), 30); } } }); });
  await new Promise(z => rs.listen(0, "127.0.0.1", z)); const rp = rs.address().port;
  const out = await RCON.exec("127.0.0.1", rp, "secret", "status"); const pl = RCON.parseStatus(out);
  ok(pl.length === 3 && pl[0].n === "Kexa" && pl[0].t === 153 && pl[1].n === "Ник с пробелом" && pl[1].t === 3907 && pl[2].bot && pl[0].id === 2 && pl[1].id === 3, "RCON status: номера, ники и время, ответ из двух пакетов собран", pl);
  let err = ""; try { await RCON.exec("127.0.0.1", rp, "wrong", "status"); } catch (e) { err = e.message; } ok(/неверный пароль/.test(err), "RCON: неверный пароль распознан", err);
  rs.close();
  console.log(fails ? `\nОШИБОК: ${fails}` : "\nОпрос серверов работает"); srv.close(); process.exit(fails ? 1 : 0);
});
