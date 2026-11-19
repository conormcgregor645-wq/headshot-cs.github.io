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
    // 2: обращения в поддержку
    `CREATE TABLE tickets(
       id INTEGER PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id),
       topic TEXT NOT NULL, subj TEXT NOT NULL,
       state TEXT NOT NULL DEFAULT 'wait',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE INDEX tickets_user ON tickets(user_id, updated_at);
     CREATE INDEX tickets_upd ON tickets(updated_at);
     CREATE TABLE ticket_msgs(
       id INTEGER PRIMARY KEY,
       ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
       user_id INTEGER NOT NULL REFERENCES users(id),
       staff INTEGER NOT NULL DEFAULT 0,
       body TEXT NOT NULL, created_at INTEGER NOT NULL
     );
     CREATE INDEX ticket_msgs_ticket ON ticket_msgs(ticket_id, id);`,
    // 3: надетые скины (по сторонам CT/T); отсюда они уходят в WeaponPaints на игровом сервере
    `CREATE TABLE loadout(
       user_id INTEGER NOT NULL REFERENCES users(id),
       team TEXT NOT NULL CHECK(team IN ('ct','t')),
       slot TEXT NOT NULL,
       item_id TEXT NOT NULL REFERENCES items(id),
       PRIMARY KEY(user_id, team, slot)
     );
     CREATE INDEX loadout_item ON loadout(item_id);`,
    // 4: баны (действуют в игре), статусы игроков, итоги месяца
    `CREATE TABLE bans(
       id INTEGER PRIMARY KEY,
       sid TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
       reason TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       until INTEGER NOT NULL DEFAULT 0,
       by_id INTEGER, by_name TEXT NOT NULL DEFAULT '',
       lifted_at INTEGER, lifted_by TEXT
     );
     CREATE INDEX bans_sid ON bans(sid);
     CREATE TABLE grants(
       id INTEGER PRIMARY KEY,
       sid TEXT NOT NULL, tier TEXT NOT NULL,
       src TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, from_at INTEGER NOT NULL, until INTEGER NOT NULL,
       by_name TEXT NOT NULL DEFAULT '', revoked_at INTEGER
     );
     CREATE INDEX grants_sid ON grants(sid);
     CREATE TABLE awards(
       period TEXT NOT NULL, place INTEGER NOT NULL,
       sid TEXT NOT NULL, name TEXT NOT NULL, pts INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY(period, place)
     );`,
    // 5: магазин — купленное оформление профиля и что надето
    `CREATE TABLE cos_own(
       user_id INTEGER NOT NULL REFERENCES users(id),
       item_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY(user_id, item_id)
     );
     ALTER TABLE users ADD COLUMN cos_eq TEXT NOT NULL DEFAULT '{}';`,
    // 6: ТК за игру, Фортуна, джекпот, кланы, свой тег в чате
    `CREATE TABLE earn_day(sid TEXT NOT NULL, day TEXT NOT NULL, base INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sid, day));
     CREATE TABLE earn_pending(sid TEXT PRIMARY KEY, tk REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
     CREATE TABLE wheel(
       user_id INTEGER PRIMARY KEY REFERENCES users(id),
       last TEXT NOT NULL DEFAULT '', streak INTEGER NOT NULL DEFAULT 0, again INTEGER NOT NULL DEFAULT 0,
       prize INTEGER, updated_at INTEGER NOT NULL
     );
     CREATE TABLE jp_rounds(
       id INTEGER PRIMARY KEY,
       created_at INTEGER NOT NULL, cd INTEGER NOT NULL DEFAULT 0, spin INTEGER NOT NULL DEFAULT 0,
       win_user INTEGER, pt REAL, total INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'open'
     );
     CREATE TABLE jp_bets(
       id INTEGER PRIMARY KEY,
       round_id INTEGER NOT NULL REFERENCES jp_rounds(id),
       user_id INTEGER NOT NULL REFERENCES users(id),
       item_id TEXT NOT NULL, value INTEGER NOT NULL, created_at INTEGER NOT NULL
     );
     CREATE INDEX jp_bets_round ON jp_bets(round_id);
     CREATE TABLE clans(
       id INTEGER PRIMARY KEY,
       name TEXT NOT NULL UNIQUE COLLATE NOCASE, tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
       color TEXT NOT NULL, emb TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '',
       ava TEXT, cover TEXT,
       leader_id INTEGER NOT NULL REFERENCES users(id),
       slots INTEGER NOT NULL DEFAULT 30, bank INTEGER NOT NULL DEFAULT 0 CHECK(bank>=0),
       created_at INTEGER NOT NULL
     );
     CREATE TABLE clan_members(
       user_id INTEGER PRIMARY KEY REFERENCES users(id),
       clan_id INTEGER NOT NULL REFERENCES clans(id),
       joined_at INTEGER NOT NULL
     );
     CREATE INDEX clan_members_clan ON clan_members(clan_id);
     CREATE TABLE clan_apps(
       id INTEGER PRIMARY KEY,
       clan_id INTEGER NOT NULL REFERENCES clans(id),
       user_id INTEGER NOT NULL REFERENCES users(id),
       created_at INTEGER NOT NULL,
       UNIQUE(clan_id, user_id)
     );
     CREATE TABLE clan_log(
       id INTEGER PRIMARY KEY, clan_id INTEGER NOT NULL, user_id INTEGER, delta INTEGER NOT NULL, what TEXT NOT NULL, created_at INTEGER NOT NULL
     );
     CREATE INDEX clan_log_clan ON clan_log(clan_id, id);
     CREATE TABLE clan_awards(
       period TEXT NOT NULL, place INTEGER NOT NULL, clan_id INTEGER NOT NULL,
       name TEXT NOT NULL, pts INTEGER NOT NULL, prize INTEGER NOT NULL, created_at INTEGER NOT NULL,
       PRIMARY KEY(period, place)
     );
     ALTER TABLE users ADD COLUMN cos_tag TEXT NOT NULL DEFAULT '';`,
    // 7: ежедневные задания
    `CREATE TABLE quest_prog(
       sid TEXT NOT NULL, day TEXT NOT NULL, qid TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(sid, day, qid)
     );`,
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
