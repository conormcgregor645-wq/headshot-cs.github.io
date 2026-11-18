"use strict";
// Опрос игрового сервера стандартным запросом Steam (A2S_INFO и A2S_PLAYER) по UDP.
const dgram = require("node:dgram");
const RCON = require("./rcon");

const HEAD = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQ = Buffer.concat([HEAD, Buffer.from("TSource Engine Query\0", "latin1")]);

// один запрос с поддержкой «вызова» (challenge): сервер может сначала прислать 0x41 и номер, тогда повторяем запрос с ним
function ask(host, port, build, want, timeout = 1500) {
  return new Promise((ok, no) => {
    const s = dgram.createSocket("udp4"); let done = false, tries = 0;
    const end = (e, v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch (_) {} e ? no(e) : ok(v); };
    const t = setTimeout(() => end(new Error("timeout")), timeout);
    s.on("error", e => end(e));
    s.on("message", m => {
      if (m.length < 5 || m.readInt32LE(0) !== -1) return end(new Error("bad packet"));
      const type = m[4];
      if (type === 0x41 && m.length >= 9 && tries++ < 3) return s.send(build(m.subarray(5, 9)), port, host);
      if (type === want) return end(null, m.subarray(5));
      end(new Error("unexpected reply 0x" + type.toString(16)));
    });
    s.send(build(null), port, host);
  });
}

function reader(b) {
  let o = 0;
  return {
    byte: () => b[o++],
    short: () => { const v = b.readInt16LE(o); o += 2; return v; },
    long: () => { const v = b.readInt32LE(o); o += 4; return v; },
    float: () => { const v = b.readFloatLE(o); o += 4; return v; },
    str: () => { const e = b.indexOf(0, o); const v = b.toString("utf8", o, e < 0 ? b.length : e); o = e < 0 ? b.length : e + 1; return v; },
    left: () => b.length - o,
  };
}

async function info(host, port, timeout) {
  const b = await ask(host, port, ch => ch ? Buffer.concat([INFO_REQ, ch]) : INFO_REQ, 0x49, timeout);
  const r = reader(b);
  r.byte(); // протокол
  const name = r.str(), map = r.str(); r.str(); r.str(); r.short();
  const players = r.byte(), max = r.byte(), bots = r.byte();
  return { name, map, players, max, bots };
}

async function players(host, port, timeout) {
  const b = await ask(host, port, ch => Buffer.concat([HEAD, Buffer.from([0x55]), ch || HEAD]), 0x44, timeout);
  const r = reader(b); const n = r.byte(); const list = [];
  for (let i = 0; i < n && r.left() > 0; i++) {
    r.byte(); const name = r.str(); const score = r.long(); const time = r.float();
    if (name) list.push({ n: name.slice(0, 32), s: score, t: Math.max(0, Math.round(time)) });
  }
  return list;
}

// список серверов из настройки GAME_SERVERS: "Название|адрес для игроков|адрес для опроса;..."
function parse(cfg) {
  return String(cfg || "").split(";").map(x => x.trim()).filter(Boolean).map(x => {
    const [name, pub, q] = x.split("|").map(y => (y || "").trim());
    const qa = (q || pub || "").split(":");
    return { name: name || "Сервер", addr: pub, host: qa[0], port: +(qa[1] || 27015) };
  }).filter(s => s.addr && s.host && s.port > 0 && s.port < 65536);
}

// CS2 открывает RCON (TCP) на адресе имени машины — в Ubuntu это 127.0.1.1, а не 127.0.0.1.
// Пробуем адрес из настроек, затем 127.0.1.1, и запоминаем рабочий.
const RCON_HOST = new Map();
async function rconStatus(s, pass, timeout) { return rconExec(s, pass, "status", timeout); }
async function rconExec(s, pass, cmd, timeout = 2500) {
  const key = s.host + ":" + s.port, first = RCON_HOST.get(key);
  const hosts = [...new Set([first, s.host, ...(/^127\./.test(s.host) ? ["127.0.1.1", "127.0.0.1"] : [])].filter(Boolean))];
  let err;
  for (const h of hosts) {
    try { const out = await RCON.exec(h, s.port, pass, cmd, timeout); RCON_HOST.set(key, h); return out; }
    catch (e) { err = e; if (e.code !== "ECONNREFUSED") break; }
  }
  throw err;
}

// опрос всех серверов; при ошибке сервер показывается как недоступный
// rconPass: если задан, ники берём из команды status (CS2 не отдаёт их в A2S_PLAYER)
async function poll(list, timeout = 1500, rconPass = "") {
  return Promise.all(list.map(async s => {
    try {
      const i = await info(s.host, s.port, timeout);
      let pl = [];
      if (rconPass && i.players > i.bots) { try { pl = RCON.parseStatus(await rconStatus(s, rconPass, timeout + 1000)).filter(p => !p.bot).map(p => ({ n: p.n, t: p.t })); } catch (e) { pl = []; } }
      else if (!rconPass) { try { pl = await players(s.host, s.port, timeout); } catch (e) {} }
      return { name: i.name || s.name, addr: s.addr, map: i.map, players: Math.max(0, i.players - i.bots), bots: i.bots, max: i.max, online: true, list: pl };
    } catch (e) {
      return { name: s.name, addr: s.addr, map: "", players: 0, bots: 0, max: 0, online: false, list: [] };
    }
  }));
}

module.exports = { info, players, parse, poll, rconExec };
