"use strict";
// База данных: встроенный в Node.js SQLite, один файл.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
  `);
  const ver = +((db.prepare("SELECT v FROM meta WHERE k='schema'").get() || {}).v || 0);
  const MIG = [
    // 1: пользователи, сессии, предметы, журнал операций
    `CREATE TABLE users(
       id INTEGER PRIMARY KEY,
       steamid TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL DEFAULT '',
       avatar TEXT NOT NULL DEFAULT '',
       role TEXT NOT NULL DEFAULT 'player',
       tk INTEGER NOT NULL DEFAULT 0 CHECK(tk>=0),
       rub INTEGER NOT NULL DEFAULT 0 CHECK(rub>=0),
       daily_day TEXT NOT NULL DEFAULT '',
       banned INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       last_login INTEGER NOT NULL
     );
     CREATE TABLE sessions(
       token_hash TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       ip TEXT, ua TEXT
     );
     CREATE INDEX sessions_user ON sessions(user_id);
     CREATE TABLE items(
       id TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id),
       w TEXT NOT NULL, s TEXT NOT NULL, r INTEGER NOT NULL,
       wear REAL NOT NULL, st INTEGER NOT NULL DEFAULT 0, sv INTEGER NOT NULL DEFAULT 0,
       sp TEXT, fx INTEGER NOT NULL DEFAULT 0, seed INTEGER NOT NULL DEFAULT 0,
       src TEXT NOT NULL, src_ref TEXT,
       state TEXT NOT NULL DEFAULT 'inv',
       created_at INTEGER NOT NULL, closed_at INTEGER
     );
     CREATE INDEX items_user ON items(user_id, state);
     CREATE INDEX items_created ON items(created_at);
     CREATE TABLE ledger(
       id INTEGER PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id),
       cur TEXT NOT NULL, delta INTEGER NOT NULL, after INTEGER NOT NULL,
       kind TEXT NOT NULL, ref TEXT, meta TEXT,
       created_at INTEGER NOT NULL
     );
     CREATE INDEX ledger_user ON ledger(user_id, id);
     CREATE TABLE case_opens(
       id INTEGER PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id),
       case_k TEXT NOT NULL, n INTEGER NOT NULL, price INTEGER NOT NULL,
       value INTEGER NOT NULL, created_at INTEGER NOT NULL
     );
     CREATE INDEX case_opens_user ON case_opens(user_id, id);`,
  ];
  for (let v = ver; v < MIG.length; v++) {
    db.exec("BEGIN");
    try { db.exec(MIG[v]); db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('schema',?)").run(String(v + 1)); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}

// транзакция: всё внутри либо выполняется целиком, либо откатывается
function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
}

module.exports = { open, tx };
