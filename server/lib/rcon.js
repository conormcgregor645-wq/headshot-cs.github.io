"use strict";
// RCON игрового сервера (протокол Source RCON по TCP) и разбор команды status.
// Нужен для списка игроков: CS2 не присылает ники в стандартном запросе Steam.
const net = require("node:net");
const { cleanNick } = require("./nick");

function pkt(id, type, body) {
  const b = Buffer.from(body, "utf8"), p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p;
}

// выполнить одну команду; ответ может прийти несколькими пакетами — собираем, пока сервер не замолчит
function exec(host, port, pass, cmd, timeout = 2500) {
  return new Promise((ok, no) => {
    const s = net.createConnection({ host, port }); let buf = Buffer.alloc(0), authed = false, out = "", quiet = null, done = false;
    const end = (e, v) => { if (done) return; done = true; clearTimeout(t); clearTimeout(quiet); s.destroy(); e ? no(e) : ok(v); };
    const t = setTimeout(() => authed ? end(null, out) : end(new Error("timeout")), timeout);
    s.on("error", e => end(e));
    s.on("close", () => authed ? end(null, out) : end(new Error("closed")));
    s.on("connect", () => s.write(pkt(1, 3, pass)));
    s.on("data", d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0); if (len < 10 || len > 1 << 20) return end(new Error("bad packet"));
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString("utf8", 12, 4 + len - 2); buf = buf.subarray(4 + len);
        if (type === 2) { // ответ на вход
          if (id === -1) return end(new Error("неверный пароль RCON"));
          if (!authed) { authed = true; s.write(pkt(2, 2, cmd)); }
        } else if (type === 0 && authed && id === 2) {
          out += body; clearTimeout(quiet); quiet = setTimeout(() => end(null, out), 150);
        }
      }
    });
  });
}

// "  2    01:05:33   36    0     active 786432 1.2.3.4:27005 'Ник'" -> {id, n, t, bot}
function parseStatus(text) {
  const list = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(BOT|[\d:]+|\[NoChan\])\s+(\d+)\s+(\d+)\s+(\w+)\s.*'(.*)'\s*$/);
    if (!m || m[1] === "65535" || m[5] !== "active") continue;
    const bot = m[2] === "BOT"; let t = 0;
    if (!bot) t = m[2].split(":").map(Number).reduce((a, x) => a * 60 + x, 0);
    const n = cleanNick(m[6]) || "Игрок"; list.push({ id: +m[1], n, t, bot });
  }
  return list;
}

module.exports = { exec, parseStatus };
