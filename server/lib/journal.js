"use strict";
// Чтение консоли игрового сервера из системного журнала (journalctl -u cs2.service -f -o json).
// Место чтения (курсор) сохраняется, поэтому после перезапуска сайта строки не теряются и не считаются дважды.
const { spawn } = require("node:child_process");

function follow({ unit, bin = "journalctl", cursor = "", since = "-24h", onLine, onCursor, log = console }) {
  let child = null, stopped = false, cur = cursor || "", saved = cur, warned = false;
  const timer = setInterval(() => { if (cur && cur !== saved) { saved = cur; try { onCursor(cur); } catch (e) {} } }, 3000);
  timer.unref();
  function start() {
    const args = ["-u", unit, "-o", "json", "-f", "--no-pager"];
    if (cur) args.push("--after-cursor=" + cur); else args.push("--since=" + since);
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l) continue;
        let j; try { j = JSON.parse(l); } catch (e) { continue; }
        let msg = j.MESSAGE; if (Array.isArray(msg)) msg = Buffer.from(msg).toString("utf8");
        if (typeof msg === "string") {
          const t = Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000) || Date.now();
          try { onLine(msg.replace(/\r$/, ""), t, j.SYSLOG_IDENTIFIER === "systemd"); } catch (e) { log.error("[журнал] ошибка разбора:", e.message); }
        }
        if (j.__CURSOR) cur = j.__CURSOR;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", d => { if (!warned) { warned = true; log.error("[журнал] journalctl:", String(d).trim().slice(0, 300)); } });
    child.on("error", e => log.error("[журнал] не запустился journalctl:", e.message));
    child.on("exit", () => { child = null; if (!stopped) setTimeout(start, 5000).unref(); });
  }
  start();
  return { stop() { stopped = true; clearInterval(timer); if (cur && cur !== saved) { try { onCursor(cur); } catch (e) {} } if (child) child.kill(); } };
}

module.exports = { follow };
