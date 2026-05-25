// =====================================================================
// The Backlog Ledger — Multiplayer Edition
// Phase 4: Steam Library Sync
// =====================================================================

const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = 47821;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'backlog.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_RETENTION_DAYS = 7;
const VERSION = require('./package.json').version;
const SYNC_RATE_LIMIT_MS = 30000; // 30s between syncs per user
const STEAM_METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOTW_XP_MULTIPLIER = 2.0;

// ---------- Logging ----------
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const todayStamp = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
function log(level, message, meta) {
  const line = `[${nowIso()}] [${level}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `app-${todayStamp()}.log`), line + '\n');
    if (level === 'ERROR' || level === 'FATAL')
      fs.appendFileSync(path.join(LOGS_DIR, `errors-${todayStamp()}.log`), line + '\n');
  } catch (err) { console.error('Log write failed:', err.message); }
}
const logger = {
  debug:(m,x)=>log('DEBUG',m,x), info:(m,x)=>log('INFO',m,x),
  warn:(m,x)=>log('WARN',m,x), error:(m,x)=>log('ERROR',m,x), fatal:(m,x)=>log('FATAL',m,x),
};
function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - (LOG_RETENTION_DAYS * 86400000);
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const full = path.join(LOGS_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); logger.info(`Deleted old log: ${f}`); }
    }
  } catch (err) { logger.warn('Log cleanup failed', { error: err.message }); }
}
cleanupOldLogs();
setInterval(cleanupOldLogs, 86400000);

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(LOGS_DIR, `crash-${todayStamp()}.log`), `=== CRASH ${nowIso()} ===\n${err.stack}\n`); } catch {}
  logger.fatal('Uncaught exception', { error: err.message });
});
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(path.join(LOGS_DIR, `crash-${todayStamp()}.log`), `=== CRASH ${nowIso()} ===\n${reason?.stack || reason}\n`); } catch {}
  logger.fatal('Unhandled rejection', { reason: String(reason) });
});

logger.info(`Backlog Ledger starting — v${VERSION}`);

// ---------- Config ----------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { port: DEFAULT_PORT };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (err) { logger.error('config.json malformed', { error: err.message }); return { port: DEFAULT_PORT }; }
}
// Persist a partial update to config.json. The port lives here (not in app_config)
// because it has to be read before the SQLite database is open.
function saveConfig(patch) {
  const current = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  const merged = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
const PORT = loadConfig().port || DEFAULT_PORT;

// ---------- Database ----------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL,
    steam_id TEXT, discord_user_id TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, last_synced_at INTEGER);
  CREATE TABLE IF NOT EXISTS games (app_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    store_price_cents INTEGER, store_price_updated_at INTEGER,
    genres_json TEXT, categories_json TEXT, steam_metadata_last_synced_at INTEGER);
  CREATE TABLE IF NOT EXISTS user_games (user_id INTEGER NOT NULL, app_id INTEGER NOT NULL,
    playtime_minutes INTEGER DEFAULT 0, playtime_last_2weeks INTEGER DEFAULT 0,
    paid_price_cents INTEGER, play_status TEXT DEFAULT 'unplayed', notes TEXT,
    manual_override INTEGER DEFAULT 0, completed_at INTEGER,
    price_is_estimated INTEGER NOT NULL DEFAULT 0, price_estimate_source TEXT,
    steam_account_id INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (app_id) REFERENCES games(app_id));
  CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    synced_at INTEGER NOT NULL, games_added INTEGER DEFAULT 0, games_updated INTEGER DEFAULT 0,
    status TEXT NOT NULL, error_message TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_user_games_user ON user_games(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_games_user_account_app
    ON user_games(user_id, COALESCE(steam_account_id, 0), app_id);
  CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id, synced_at);
  CREATE TABLE IF NOT EXISTS pending_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_name_raw TEXT NOT NULL,
    paid_price_cents INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    taken_at INTEGER NOT NULL,
    stats_json TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_snapshots_user_time ON leaderboard_snapshots(user_id, taken_at);
  CREATE TABLE IF NOT EXISTS match_overrides (
    user_id INTEGER NOT NULL,
    raw_name_lc TEXT NOT NULL,
    app_id INTEGER NOT NULL,
    learned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, raw_name_lc),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS import_decisions (
    user_id INTEGER NOT NULL,
    import_kind TEXT NOT NULL,
    raw_name_lc TEXT NOT NULL,
    action TEXT NOT NULL,
    app_ids_json TEXT,
    custom_name TEXT,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, import_kind, raw_name_lc),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS xp_baseline (
    user_id INTEGER NOT NULL,
    app_id INTEGER NOT NULL,
    baseline_minutes INTEGER NOT NULL,
    baseline_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, app_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_xp_baseline_user ON xp_baseline(user_id);
  CREATE TABLE IF NOT EXISTS xp_baseline_backup (
    user_id INTEGER NOT NULL,
    steam_id TEXT,
    display_name TEXT,
    app_id INTEGER NOT NULL,
    baseline_minutes INTEGER NOT NULL,
    baseline_at INTEGER NOT NULL,
    backed_up_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_xp_backup_steam ON xp_baseline_backup(steam_id);
  CREATE TABLE IF NOT EXISTS games_of_week (
    week_start_at INTEGER PRIMARY KEY,
    group_app_id INTEGER,
    personal_picks_json TEXT NOT NULL,
    picked_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS game_merge_groups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    primary_app_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_merge_groups_user ON game_merge_groups(user_id);
  CREATE TABLE IF NOT EXISTS game_merge_members (
    group_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    app_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, app_id),
    UNIQUE (group_id, app_id),
    FOREIGN KEY (group_id) REFERENCES game_merge_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_merge_members_group ON game_merge_members(group_id);
  CREATE TABLE IF NOT EXISTS user_steam_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    steam_id TEXT NOT NULL UNIQUE,
    label TEXT,
    persona_name TEXT,
    avatar_url TEXT,
    added_at INTEGER NOT NULL,
    last_synced_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_steam_accounts_user ON user_steam_accounts(user_id);
  CREATE TABLE IF NOT EXISTS weekly_xp_winners (
    week_start_at INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    xp_gained REAL NOT NULL,
    hours_gained REAL DEFAULT 0,
    picked_app_id INTEGER,
    prompted_at INTEGER,
    picked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
`;
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);
// Idempotent migration: add price_is_estimated column if missing
try {
  const cols = db.prepare("PRAGMA table_info(user_games)").all();
  if (!cols.some(c => c.name === 'price_is_estimated')) {
    db.exec('ALTER TABLE user_games ADD COLUMN price_is_estimated INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added price_is_estimated column');
  }
  if (!cols.some(c => c.name === 'price_estimate_source')) {
    db.exec('ALTER TABLE user_games ADD COLUMN price_estimate_source TEXT');
    logger.info('Migration: added price_estimate_source column');
  }
  // Multi-Steam: tag each user_games row with the Steam account it came from
  if (!cols.some(c => c.name === 'steam_account_id')) {
    db.exec('ALTER TABLE user_games ADD COLUMN steam_account_id INTEGER');
    logger.info('Migration: added steam_account_id column to user_games');
  }
} catch (err) { logger.error('Migration failed', { error: err.message }); }

// Idempotent migration: cache Steam store metadata on the shared game catalog.
try {
  const gameCols = db.prepare("PRAGMA table_info(games)").all();
  if (!gameCols.some(c => c.name === 'genres_json')) {
    db.exec('ALTER TABLE games ADD COLUMN genres_json TEXT');
    logger.info('Migration: added genres_json column to games');
  }
  if (!gameCols.some(c => c.name === 'categories_json')) {
    db.exec('ALTER TABLE games ADD COLUMN categories_json TEXT');
    logger.info('Migration: added categories_json column to games');
  }
  if (!gameCols.some(c => c.name === 'steam_metadata_last_synced_at')) {
    db.exec('ALTER TABLE games ADD COLUMN steam_metadata_last_synced_at INTEGER');
    logger.info('Migration: added steam_metadata_last_synced_at column to games');
  }
} catch (err) { logger.error('Game metadata migration failed', { error: err.message }); }

// Idempotent migration: old builds keyed user_games by (user_id, app_id),
// which made overlapping games across multiple Steam accounts impossible.
try {
  const cols = db.prepare("PRAGMA table_info(user_games)").all();
  const pkCols = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (pkCols.join(',') === 'user_id,app_id') {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE user_games_new (
          user_id INTEGER NOT NULL,
          app_id INTEGER NOT NULL,
          playtime_minutes INTEGER DEFAULT 0,
          playtime_last_2weeks INTEGER DEFAULT 0,
          paid_price_cents INTEGER,
          play_status TEXT DEFAULT 'unplayed',
          notes TEXT,
          manual_override INTEGER DEFAULT 0,
          completed_at INTEGER,
          price_is_estimated INTEGER NOT NULL DEFAULT 0,
          price_estimate_source TEXT,
          steam_account_id INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (app_id) REFERENCES games(app_id)
        );
        INSERT INTO user_games_new (
          user_id, app_id, playtime_minutes, playtime_last_2weeks,
          paid_price_cents, play_status, notes, manual_override, completed_at,
          price_is_estimated, price_estimate_source, steam_account_id
        )
        SELECT
          user_id, app_id, playtime_minutes, playtime_last_2weeks,
          paid_price_cents, play_status, notes, manual_override, completed_at,
          COALESCE(price_is_estimated, 0), price_estimate_source, steam_account_id
        FROM user_games;
        DROP TABLE user_games;
        ALTER TABLE user_games_new RENAME TO user_games;
        CREATE INDEX IF NOT EXISTS idx_user_games_user ON user_games(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_games_user_account_app
          ON user_games(user_id, COALESCE(steam_account_id, 0), app_id);
      `);
    })();
    db.pragma('foreign_keys = ON');
    logger.info('Migration: rebuilt user_games with account-aware uniqueness');
  } else {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_games_user_account_app
      ON user_games(user_id, COALESCE(steam_account_id, 0), app_id)`);
  }
} catch (err) {
  try { db.pragma('foreign_keys = ON'); } catch {}
  logger.error('Account-aware user_games migration failed', { error: err.message });
}

// Idempotent migration: backfill user_steam_accounts from users.steam_id
try {
  const usersWithSteam = db.prepare(`SELECT u.id, u.display_name, u.steam_id, u.avatar_url
    FROM users u WHERE u.steam_id IS NOT NULL AND u.steam_id != ''
    AND NOT EXISTS (SELECT 1 FROM user_steam_accounts WHERE steam_id = u.steam_id)`).all();
  if (usersWithSteam.length > 0) {
    const stmt = db.prepare(`INSERT INTO user_steam_accounts (user_id, steam_id, label, persona_name, avatar_url, added_at, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
      for (const u of usersWithSteam) {
        const lastSync = db.prepare('SELECT last_synced_at FROM users WHERE id = ?').get(u.id);
        stmt.run(u.id, u.steam_id, 'Main', u.display_name, u.avatar_url, now, lastSync?.last_synced_at || null);
      }
    })();
    logger.info('Migration: backfilled user_steam_accounts', { count: usersWithSteam.length });
  }
  // Backfill steam_account_id on user_games for users with exactly one account
  const orphanRows = db.prepare(`SELECT COUNT(*) AS c FROM user_games WHERE steam_account_id IS NULL`).get();
  if (orphanRows.c > 0) {
    db.transaction(() => {
      const usersWithOneAccount = db.prepare(`SELECT user_id, MIN(id) AS account_id, COUNT(*) AS n
        FROM user_steam_accounts GROUP BY user_id HAVING n = 1`).all();
      const setStmt = db.prepare(`UPDATE user_games SET steam_account_id = ?
        WHERE user_id = ? AND steam_account_id IS NULL`);
      for (const row of usersWithOneAccount) {
        setStmt.run(row.account_id, row.user_id);
      }
    })();
    logger.info('Migration: assigned steam_account_id to existing user_games rows');
  }
} catch (err) { logger.error('Backfill migration failed', { error: err.message }); }
logger.info(`Database ready at ${DB_PATH}`);

// ---------- Helpers ----------
const getConfig = (k) => { const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get(k); return r ? r.value : null; };
const setConfig = (k, v) => db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(k, v, Date.now());
const deleteConfig = (k) => db.prepare('DELETE FROM app_config WHERE key = ?').run(k);
const isSetupComplete = () => !!getConfig('setup_completed_at');
const hashPassword = (pw) => crypto.scryptSync(pw, 'backlog-ledger-salt', 64).toString('hex');
function verifyPassword(pw) {
  const stored = getConfig('admin_password_hash');
  if (!stored || !pw) return false;
  try { return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hashPassword(pw), 'hex')); }
  catch { return false; }
}
function accountKey(accountId) {
  return accountId == null ? 0 : Number(accountId);
}
function getPrimarySteamAccountId(userId) {
  return db.prepare('SELECT id FROM user_steam_accounts WHERE user_id = ? ORDER BY added_at ASC LIMIT 1').get(userId)?.id || null;
}
function getCanonicalUserGame(userId, appId, preferredAccountId = null) {
  if (preferredAccountId) {
    const preferred = db.prepare(`SELECT * FROM user_games
      WHERE user_id = ? AND app_id = ? AND steam_account_id = ?`).get(userId, appId, preferredAccountId);
    if (preferred) return preferred;
  }
  return db.prepare(`SELECT * FROM user_games
    WHERE user_id = ? AND app_id = ?
    ORDER BY steam_account_id IS NULL DESC,
      paid_price_cents IS NOT NULL DESC,
      manual_override DESC,
      steam_account_id ASC
    LIMIT 1`).get(userId, appId);
}
function clearDuplicateLedgerFields(userId, appId, keepAccountId, fields) {
  const key = accountKey(keepAccountId);
  const updates = [];
  if (fields.price) updates.push('paid_price_cents = NULL', 'price_is_estimated = 0', 'price_estimate_source = NULL');
  if (fields.status) updates.push("play_status = 'unplayed'", 'completed_at = NULL');
  if (fields.notes) updates.push('notes = NULL');
  if (!updates.length) return;
  db.prepare(`UPDATE user_games SET ${updates.join(', ')}
    WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) != ?`).run(userId, appId, key);
}
function updateCanonicalPrice(userId, appId, cents, isEstimated, source) {
  const row = getCanonicalUserGame(userId, appId, getPrimarySteamAccountId(userId));
  if (!row) return 0;
  const result = db.prepare(`UPDATE user_games
    SET paid_price_cents = ?, price_is_estimated = ?, price_estimate_source = ?
    WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`)
    .run(cents, isEstimated ? 1 : 0, source || null, userId, appId, accountKey(row.steam_account_id));
  clearDuplicateLedgerFields(userId, appId, row.steam_account_id, { price: true });
  return result.changes;
}

function mergeStatusPriority(a, b) {
  if (a === 'completed' || b === 'completed') return 'completed';
  if (a === 'exempt' || b === 'exempt') return 'exempt';
  if (a === 'free' || b === 'free') return 'free';
  return a || b || 'unplayed';
}

function mergeGameRows(existing, r) {
  existing.playtime_minutes = (existing.playtime_minutes || 0) + (r.playtime_minutes || 0);
  existing.playtime_last_2weeks = (existing.playtime_last_2weeks || 0) + (r.playtime_last_2weeks || 0);
  existing.paid_price_cents = (existing.paid_price_cents || 0) + (r.paid_price_cents || 0);
  existing.play_status = mergeStatusPriority(existing.play_status, r.play_status);
  if (r.completed_at && !existing.completed_at) existing.completed_at = r.completed_at;
  if (r.notes && !existing.notes) existing.notes = r.notes;
  existing.manual_override = existing.manual_override || r.manual_override;
  if (r.price_is_estimated) {
    existing.price_is_estimated = 1;
    if (r.price_estimate_source && !existing.price_estimate_source) existing.price_estimate_source = r.price_estimate_source;
  }
  return existing;
}

function aggregateUserGamesByApp(userId, includeMeta = false) {
  const cols = includeMeta
    ? `g.app_id, g.name, g.genres_json, g.categories_json, g.steam_metadata_last_synced_at,
       ug.playtime_minutes, ug.playtime_last_2weeks, ug.paid_price_cents, ug.play_status,
       ug.manual_override, ug.completed_at, ug.notes, COALESCE(ug.price_is_estimated, 0) AS price_is_estimated,
       ug.price_estimate_source, ug.steam_account_id`
    : `g.app_id, g.name, ug.playtime_minutes, ug.playtime_last_2weeks, ug.paid_price_cents,
       ug.play_status, ug.manual_override, ug.completed_at, ug.notes,
       COALESCE(ug.price_is_estimated, 0) AS price_is_estimated, ug.price_estimate_source`;
  const raw = db.prepare(`SELECT ${cols}
    FROM user_games ug JOIN games g ON g.app_id = ug.app_id
    WHERE ug.user_id = ?`).all(userId);
  const byApp = new Map();
  for (const r of raw) {
    const existing = byApp.get(r.app_id);
    if (!existing) byApp.set(r.app_id, { ...r });
    else mergeGameRows(existing, r);
  }
  return byApp;
}

function serialiseMergeGroup(row, members = null) {
  const groupMembers = members || db.prepare(`SELECT gm.app_id, g.name
    FROM game_merge_members gm LEFT JOIN games g ON g.app_id = gm.app_id
    WHERE gm.group_id = ? ORDER BY g.name COLLATE NOCASE`).all(row.id);
  return {
    id: row.id,
    playerId: String(row.user_id),
    primaryAppId: String(row.primary_app_id),
    mergedAppIds: groupMembers.map(m => String(m.app_id)),
    games: groupMembers.map(m => ({ app_id: m.app_id, name: m.name || `App ${m.app_id}` })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getMergedGamesForPlayer(playerId) {
  const groups = db.prepare('SELECT * FROM game_merge_groups WHERE user_id = ? ORDER BY created_at').all(playerId);
  return groups.map(g => serialiseMergeGroup(g));
}

function getMergeGroupForGame(playerId, appId) {
  const row = db.prepare(`SELECT g.* FROM game_merge_groups g
    JOIN game_merge_members m ON m.group_id = g.id
    WHERE m.user_id = ? AND m.app_id = ?`).get(playerId, appId);
  return row ? serialiseMergeGroup(row) : null;
}

function getPrimaryGameForMergeGroup(group) {
  const appId = Number(group.primaryAppId || group.primary_app_id);
  return db.prepare('SELECT app_id, name FROM games WHERE app_id = ?').get(appId) || null;
}

function isGameInSameMergeGroup(playerId, appIdA, appIdB) {
  if (Number(appIdA) === Number(appIdB)) return true;
  const group = getMergeGroupForGame(playerId, appIdA);
  return !!group && group.mergedAppIds.map(Number).includes(Number(appIdB));
}

function doesMergeGroupContainDoubleXpGame(playerId, mergeGroup) {
  const gotw = getCurrentGotWPicks();
  const personal = gotw?.personal_picks?.[playerId] ?? gotw?.personal_picks?.[String(playerId)];
  const ids = (mergeGroup.mergedAppIds || []).map(Number);
  return (gotw?.group_app_id && ids.includes(Number(gotw.group_app_id))) ||
    (personal && ids.includes(Number(personal)));
}

function qualifiesForDoubleXp(playerId, playedAppId, doubleXpAppId) {
  // Manual merge acceptance scenario:
  // Metro Exodus (412020) + Metro Exodus Enhanced Edition (1449560) can be
  // merged per player. If 412020 is GotW/Double XP and the player adds time
  // to 1449560, this helper makes the XP receipt award x2 XP for that play.
  // The effective ledger row remains one visible merged contract with a member
  // breakdown, and GotW pools see only that one effective contract.
  if (!doubleXpAppId) return false;
  if (Number(playedAppId) === Number(doubleXpAppId)) return true;
  return isGameInSameMergeGroup(playerId, playedAppId, doubleXpAppId);
}

function isUnpaidContractRow(row) {
  if (!row || row.play_status === 'exempt' || row.play_status === 'free' || row.play_status === 'completed') return false;
  const price = (row.paid_price_cents || 0) / 100;
  const hours = (row.playtime_minutes || 0) / 60;
  return price > 0 && hours < price;
}

function applyMergeGroupsToGameMap(playerId, byApp, opts = {}) {
  const groups = db.prepare('SELECT * FROM game_merge_groups WHERE user_id = ?').all(playerId);
  if (!groups.length) return [...byApp.values()];
  const groupRows = [];
  const consumed = new Set();
  const gotw = opts.gotwPicks || null;
  const personal = gotw ? (gotw.personal_picks?.[playerId] ?? gotw.personal_picks?.[String(playerId)]) : null;

  for (const group of groups) {
    const members = db.prepare(`SELECT gm.app_id, g.name FROM game_merge_members gm
      LEFT JOIN games g ON g.app_id = gm.app_id WHERE gm.group_id = ?`).all(group.id);
    const presentMembers = members.filter(m => byApp.has(m.app_id));
    if (presentMembers.length < 2) continue;
    const primary = byApp.get(group.primary_app_id) || byApp.get(presentMembers[0].app_id);
    const merged = {
      ...primary,
      app_id: primary.app_id,
      name: primary.name,
      merge_group_id: group.id,
      is_merged: true,
      primary_app_id: group.primary_app_id,
      merged_app_ids: members.map(m => m.app_id),
      merged_count: presentMembers.length,
      merged_games: presentMembers.map(m => ({ ...byApp.get(m.app_id), is_primary: m.app_id === group.primary_app_id })),
      playtime_minutes: 0,
      playtime_last_2weeks: 0,
      paid_price_cents: 0,
      play_status: 'unplayed',
      manual_override: 0,
      completed_at: null,
      notes: null,
      price_is_estimated: 0,
      price_estimate_source: null,
      steam_accounts: [],
      account_breakdown: [],
      qualifies_double_xp: false,
    };
    for (const m of presentMembers) {
      consumed.add(m.app_id);
      const memberRow = byApp.get(m.app_id);
      mergeGameRows(merged, memberRow);
      if (Array.isArray(memberRow.steam_accounts)) {
        for (const account of memberRow.steam_accounts) {
          if (!merged.steam_accounts.some(a => a.id === account.id)) merged.steam_accounts.push(account);
        }
      }
      if (Array.isArray(memberRow.account_breakdown)) {
        for (const entry of memberRow.account_breakdown) merged.account_breakdown.push({ ...entry, app_id: m.app_id, game_name: memberRow.name });
      }
    }
    // Manual merge groups are one ledger contract with multiple playable app IDs.
    // Default contract price/status to the primary game so free enhanced editions
    // and remasters do not inflate debt. TODO: add an explicit pricing_mode if
    // groups later need to opt into summed member prices.
    merged.paid_price_cents = primary.paid_price_cents || 0;
    merged.play_status = primary.play_status || 'unplayed';
    merged.completed_at = primary.completed_at || null;
    merged.notes = primary.notes || null;
    merged.manual_override = primary.manual_override || 0;
    merged.price_is_estimated = primary.price_is_estimated || 0;
    merged.price_estimate_source = primary.price_estimate_source || null;
    if (gotw) {
      merged.qualifies_double_xp = members.some(m =>
        qualifiesForDoubleXp(playerId, m.app_id, gotw.group_app_id) ||
        qualifiesForDoubleXp(playerId, m.app_id, personal)
      );
    }
    groupRows.push(merged);
  }

  for (const r of byApp.values()) {
    if (!consumed.has(r.app_id)) groupRows.push(r);
  }
  return groupRows;
}

function getEffectiveLedgerEntriesForPlayer(playerId, opts = {}) {
  return applyMergeGroupsToGameMap(playerId, aggregateUserGamesByApp(playerId, !!opts.includeMeta), opts);
}

// ---------- Steam helpers (Phase 2/3) ----------
async function testSteamKey(apiKey) {
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return { ok: false, error: `Steam returned HTTP ${res.status}` };
    await res.json(); return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function resolveSteamId(input) {
  const apiKey = getConfig('steam_api_key');
  if (!apiKey) return { ok: false, error: 'Steam API key not configured' };
  let raw = String(input || '').trim();
  const urlMatch = raw.match(/steamcommunity\.com\/(?:id|profiles)\/([^\/\?#]+)/i);
  if (urlMatch) raw = urlMatch[1];
  if (/^\d{17}$/.test(raw)) return await fetchSteamProfile(raw, apiKey);
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(raw)}`);
    const data = await res.json();
    if (data?.response?.success === 1) return await fetchSteamProfile(data.response.steamid, apiKey);
    return { ok: false, error: 'Vanity URL not found — check spelling' };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function fetchSteamProfile(steamId, apiKey) {
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`);
    if (!res.ok) return { ok: false, error: `Steam returned HTTP ${res.status}` };
    const data = await res.json();
    const player = data?.response?.players?.[0];
    if (!player) return { ok: false, error: 'Steam profile not found' };
    return { ok: true, steam_id: steamId, persona_name: player.personaname, avatar_url: player.avatarmedium };
  } catch (err) { return { ok: false, error: err.message }; }
}
function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch { return []; }
}
function uniqueNames(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const name = String(r?.description || '').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}
function getSteamMetadataPause() {
  const raw = getConfig('steam_metadata_paused_json');
  if (!raw) return null;
  try {
    const pause = JSON.parse(raw);
    return pause?.paused_at ? pause : null;
  } catch { return null; }
}
function pauseSteamMetadata(reason, meta = {}) {
  const pause = {
    paused_at: Date.now(),
    reason: reason || 'Steam metadata refresh paused',
    ...meta,
  };
  setConfig('steam_metadata_paused_json', JSON.stringify(pause));
  return pause;
}
function resumeSteamMetadata() {
  deleteConfig('steam_metadata_paused_json');
  if (steamMetadataState.status === 'paused') {
    steamMetadataState.status = 'idle';
    steamMetadataState.pause = null;
  }
}

// Live tracker for the help-button status indicator.
const steamMetadataState = {
  status: 'idle', // 'idle' | 'running' | 'paused' | 'done' | 'error'
  total: 0,
  checked: 0,
  updated: 0,
  failed: 0,
  rate_limited: 0,
  started_at: null,
  finished_at: null,
  pause: null,
};

// Background queue so syncs don't block on Steam Store metadata fetches.
const steamMetadataQueue = new Set();
let steamMetadataDraining = false;

function queueSteamMetadataRefresh(appIds, opts = {}) {
  const ids = (appIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  for (const id of ids) steamMetadataQueue.add(id);
  if (steamMetadataDraining) return;
  drainSteamMetadataQueue(opts).catch(err => {
    logger.error('Background Steam metadata drain crashed', { error: err.message });
    steamMetadataState.status = 'error';
    steamMetadataState.finished_at = Date.now();
  });
}

async function drainSteamMetadataQueue(opts = {}) {
  if (steamMetadataDraining) return;
  steamMetadataDraining = true;
  try {
    while (steamMetadataQueue.size > 0) {
      const batch = [...steamMetadataQueue];
      steamMetadataQueue.clear();
      await refreshSteamMetadataForAppIds(batch, opts);
      if (getSteamMetadataPause()) break;
    }
  } finally {
    steamMetadataDraining = false;
    if (steamMetadataState.status === 'running' && steamMetadataQueue.size === 0) {
      steamMetadataState.status = 'done';
      steamMetadataState.finished_at = Date.now();
    }
  }
}

async function refreshSteamMetadataForAppIds(appIds, opts = {}) {
  const existingPause = getSteamMetadataPause();
  if (existingPause && !opts.ignorePause) {
    steamMetadataState.status = 'paused';
    steamMetadataState.pause = existingPause;
    return { checked: 0, updated: 0, skipped: 0, failed: 0, paused: true, pause: existingPause };
  }

  const ids = [...new Set((appIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { checked: 0, updated: 0, skipped: 0, failed: 0 };

  const now = Date.now();
  const force = !!opts.force;
  const placeholders = ids.map(() => '?').join(',');
  const existing = db.prepare(`SELECT app_id, genres_json, categories_json, steam_metadata_last_synced_at
    FROM games WHERE app_id IN (${placeholders})`).all(...ids);
  const existingById = new Map(existing.map(r => [r.app_id, r]));
  const candidates = ids.filter(id => {
    const row = existingById.get(id);
    if (!row) return false;
    if (force) return true;
    if (!row.steam_metadata_last_synced_at) return true;
    if (!row.genres_json || !row.categories_json) return true;
    return now - row.steam_metadata_last_synced_at > STEAM_METADATA_TTL_MS;
  });
  if (!candidates.length) return { checked: ids.length, updated: 0, skipped: ids.length, failed: 0 };

  // Initialise or extend the live status tracker.
  if (steamMetadataState.status !== 'running') {
    steamMetadataState.status = 'running';
    steamMetadataState.total = candidates.length;
    steamMetadataState.checked = 0;
    steamMetadataState.updated = 0;
    steamMetadataState.failed = 0;
    steamMetadataState.rate_limited = 0;
    steamMetadataState.started_at = Date.now();
    steamMetadataState.finished_at = null;
    steamMetadataState.pause = null;
  } else {
    steamMetadataState.total += candidates.length;
  }

  const update = db.prepare(`UPDATE games
    SET genres_json = ?, categories_json = ?, steam_metadata_last_synced_at = ?
    WHERE app_id = ?`);
  const saveEntry = (appId, entry) => {
    if (!entry?.success || !entry?.data) return false;
    update.run(
      JSON.stringify(uniqueNames(entry.data.genres)),
      JSON.stringify(uniqueNames(entry.data.categories)),
      now,
      appId
    );
    return true;
  };
  let updated = 0, failed = 0, rateLimited = 0, forbidden = 0;
  for (let i = 0; i < candidates.length; i++) {
    const appId = candidates[i];
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=gb&l=english`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429) {
          rateLimited++;
          steamMetadataState.rate_limited++;
          logger.warn('Steam metadata refresh paused by rate limit', { app_id: appId, checked: i + 1, remaining: candidates.length - i - 1 });
          await new Promise(r => setTimeout(r, 5000));
          failed++;
          steamMetadataState.failed++;
        } else if (res.status === 403) {
          forbidden++;
          failed++;
          steamMetadataState.failed++;
          const pause = pauseSteamMetadata('Steam Store returned 403 Forbidden', {
            app_id: appId,
            status: 403,
            checked: i + 1,
            remaining: candidates.length - i - 1,
          });
          logger.warn('Steam metadata request forbidden; paused metadata refresh', { app_id: appId, checked: i + 1, remaining: candidates.length - i - 1, paused_at: pause.paused_at });
          failed += candidates.length - i - 1;
          steamMetadataState.failed += candidates.length - i - 1;
          steamMetadataState.status = 'paused';
          steamMetadataState.pause = pause;
          steamMetadataState.checked = i + 1;
          break;
        } else {
          failed++;
          steamMetadataState.failed++;
          logger.warn('Steam metadata request failed', { app_id: appId, status: res.status });
        }
      } else {
        const data = await res.json();
        if (saveEntry(appId, data?.[String(appId)])) { updated++; steamMetadataState.updated++; }
        else { failed++; steamMetadataState.failed++; }
      }
    } catch (err) {
      failed++;
      steamMetadataState.failed++;
      logger.warn('Steam metadata refresh failed', { app_id: appId, error: err.message });
    }
    steamMetadataState.checked++;
    if ((i + 1) % 25 === 0) logger.info('Steam metadata refresh progress', { checked: i + 1, total: candidates.length, updated, failed, rate_limited: rateLimited, forbidden });
    if (i + 1 < candidates.length) await new Promise(r => setTimeout(r, 900));
  }
  return { checked: ids.length, updated, skipped: ids.length - candidates.length, failed, rate_limited: rateLimited, forbidden, paused: !!getSteamMetadataPause() };
}
async function testDiscord(token, channelId, sendMessage) {
  try {
    const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers });
    if (!meRes.ok) return { ok: false, error: `Invalid bot token (HTTP ${meRes.status})` };
    const me = await meRes.json();
    const chRes = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers });
    if (!chRes.ok) return { ok: false, error: `Channel not accessible (HTTP ${chRes.status})` };
    const ch = await chRes.json();
    if (sendMessage) {
      const s = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`,
        { method:'POST', headers, body: JSON.stringify({ content: '✅ Hello from The Backlog Ledger! Setup successful.' }) });
      if (!s.ok) return { ok: false, error: `Cannot post to channel (HTTP ${s.status})` };
    }
    return { ok: true, bot_name: me.username, channel_name: ch.name };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ---------- PHASE 4: Steam library sync ----------
// Sync one specific Steam account (by user_steam_accounts.id)
async function syncSteamAccount(accountId, opts = {}) {
  const account = db.prepare('SELECT * FROM user_steam_accounts WHERE id = ?').get(accountId);
  if (!account) return { ok: false, error: 'Steam account not found' };
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(account.user_id);
  if (!user) return { ok: false, error: 'User not found' };
  const apiKey = getConfig('steam_api_key');
  if (!apiKey) return { ok: false, error: 'Steam API key not configured' };

  const userId = account.user_id;
  const steamId = account.steam_id;
  const accountLabel = account.label || 'Account';
  const startedAt = Date.now();
  logger.info('Sync started', { user_id: userId, account_id: accountId, steam_id: steamId, label: accountLabel });

  let response;
  try {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`;
    response = await fetch(url);
  } catch (err) {
    db.prepare(`INSERT INTO sync_log (user_id, synced_at, status, error_message) VALUES (?,?,?,?)`)
      .run(userId, Date.now(), 'error', `Network (account ${accountLabel}): ${err.message}`);
    logger.error('Sync network error', { user_id: userId, account_id: accountId, error: err.message });
    return { ok: false, error: 'Network error reaching Steam: ' + err.message };
  }

  if (!response.ok) {
    const msg = `Steam returned HTTP ${response.status}`;
    db.prepare(`INSERT INTO sync_log (user_id, synced_at, status, error_message) VALUES (?,?,?,?)`)
      .run(userId, Date.now(), 'error', msg);
    logger.error('Sync HTTP error', { user_id: userId, account_id: accountId, status: response.status });
    return { ok: false, error: msg };
  }

  const data = await response.json();
  const games = data?.response?.games;

  if (!games || !Array.isArray(games)) {
    const msg = `No games returned for "${accountLabel}" — profile may be private. Set "Game details" to Public in Steam.`;
    db.prepare(`INSERT INTO sync_log (user_id, synced_at, status, error_message) VALUES (?,?,?,?)`)
      .run(userId, Date.now(), 'error', `Private profile or no games on ${accountLabel}`);
    logger.warn('Sync returned no games', { user_id: userId, account_id: accountId });
    return { ok: false, error: msg };
  }

  // Prepared statements
  const insertGame = db.prepare(`INSERT INTO games (app_id, name) VALUES (?, ?)
    ON CONFLICT(app_id) DO UPDATE SET name = excluded.name`);
  const getUserGameForAccount = db.prepare(`SELECT manual_override, playtime_minutes
    FROM user_games WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`);
  const insertUserGame = db.prepare(`INSERT INTO user_games (user_id, app_id, playtime_minutes, playtime_last_2weeks, steam_account_id)
    VALUES (?, ?, ?, ?, ?)`);
  const updateUserGame = db.prepare(`UPDATE user_games SET playtime_minutes = ?, playtime_last_2weeks = ?
    WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`);

  // XP baselines: check if this account has any baselines yet
  const baselineCount = db.prepare(`SELECT COUNT(*) AS c FROM xp_baseline xb
    JOIN user_games ug ON ug.user_id = xb.user_id AND ug.app_id = xb.app_id
    WHERE xb.user_id = ? AND ug.steam_account_id = ?`).get(userId, accountId).c;
  const isFirstSyncForAccount = baselineCount === 0;

  // Restore baselines from backup if first sync for this Steam ID
  let restoredBaselines = 0;
  if (isFirstSyncForAccount && steamId) {
    const backups = db.prepare(`SELECT app_id, baseline_minutes, baseline_at
      FROM xp_baseline_backup WHERE steam_id = ?`).all(steamId);
    if (backups.length > 0) {
      const restore = db.prepare(`INSERT OR IGNORE INTO xp_baseline (user_id, app_id, baseline_minutes, baseline_at)
        VALUES (?, ?, ?, ?)`);
      db.transaction(() => {
        for (const b of backups) restore.run(userId, b.app_id, b.baseline_minutes, b.baseline_at);
      })();
      restoredBaselines = backups.length;
      logger.info('XP baselines restored from backup', { user_id: userId, account_id: accountId, steam_id: steamId, count: restoredBaselines });
    }
  }

  const setBaseline = db.prepare(`INSERT OR IGNORE INTO xp_baseline (user_id, app_id, baseline_minutes, baseline_at)
    VALUES (?, ?, ?, ?)`);
  // Bump baseline by N minutes for cases where this account's games are joining
  // an existing user baseline — we don't want to retroactively credit hours played
  // on a Steam account before it was linked.
  const bumpBaseline = db.prepare(`UPDATE xp_baseline SET baseline_minutes = baseline_minutes + ?
    WHERE user_id = ? AND app_id = ?`);
  const backupBaseline = db.prepare(`INSERT INTO xp_baseline_backup
    (user_id, steam_id, display_name, app_id, baseline_minutes, baseline_at, backed_up_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // First-time sync for THIS account means we need to add its starting playtime to
  // any pre-existing baseline (so the user doesn't get retroactive XP for those hours).
  const isFirstSyncForThisAccount = !db.prepare(
    `SELECT 1 FROM user_games WHERE user_id = ? AND steam_account_id = ? LIMIT 1`
  ).get(userId, accountId);

  let added = 0, updated = 0, skipped = 0, baselinesSet = 0, baselinesBumped = 0;

  const txn = db.transaction(() => {
    const now = Date.now();
    for (const g of games) {
      if (!g.appid || !g.name) continue;
      insertGame.run(g.appid, g.name);

      const existing = getUserGameForAccount.get(userId, g.appid, accountId);
      const minutes = g.playtime_forever || 0;
      const recent = g.playtime_2weeks || 0;

      if (!existing) {
        insertUserGame.run(userId, g.appid, minutes, recent, accountId);
        added++;
        // If a baseline already exists for this app (from another account), bump it
        // by THIS account's starting minutes — they shouldn't count as XP-earning hours.
        if (isFirstSyncForThisAccount && minutes > 0) {
          const existingBaseline = db.prepare(
            'SELECT 1 FROM xp_baseline WHERE user_id = ? AND app_id = ?'
          ).get(userId, g.appid);
          if (existingBaseline) {
            bumpBaseline.run(minutes, userId, g.appid);
            baselinesBumped++;
            continue; // skip the setBaseline below
          }
        }
      } else if (existing.manual_override) {
        skipped++;
      } else {
        updateUserGame.run(minutes, recent, userId, g.appid, accountId);
        updated++;
      }

      // Baseline: per (user_id, app_id) — first sync that sees this game wins
      const result = setBaseline.run(userId, g.appid, minutes, now);
      if (result.changes > 0) {
        baselinesSet++;
        if (steamId) {
          backupBaseline.run(userId, steamId, user.display_name, g.appid, minutes, now, now);
        }
      }
    }
    db.prepare('UPDATE user_steam_accounts SET last_synced_at = ? WHERE id = ?').run(Date.now(), accountId);
    db.prepare('UPDATE users SET last_synced_at = ? WHERE id = ?').run(Date.now(), userId);
    db.prepare(`INSERT INTO sync_log (user_id, synced_at, games_added, games_updated, status) VALUES (?,?,?,?,?)`)
      .run(userId, Date.now(), added, updated, 'ok');
  });
  txn();

  // Queue Steam Store metadata refresh in the background so the sync request
  // returns immediately. Progress is exposed via /api/steam-metadata/status.
  queueSteamMetadataRefresh(games.map(g => g.appid), { force: !!opts.refreshMetadata });

  const elapsed = Date.now() - startedAt;
  logger.info('Sync complete', { user_id: userId, account_id: accountId, label: accountLabel, added, updated, skipped, total: games.length, ms: elapsed, baselines_set: baselinesSet, baselines_bumped: baselinesBumped, baselines_restored: restoredBaselines, metadata_queued: games.length });
  setImmediate(() => {
    if (app && app.locals && app.locals.broadcastLeaderboardUpdate) {
      app.locals.broadcastLeaderboardUpdate(userId, 'sync');
    }
  });
  return { ok: true, added, updated, skipped, total: games.length, elapsed_ms: elapsed, account_label: accountLabel, metadata: { queued: games.length } };
}

// Sync ALL of a user's linked Steam accounts. Returns aggregate result.
async function syncUserLibrary(userId, opts = {}) {
  const accounts = db.prepare('SELECT id, label FROM user_steam_accounts WHERE user_id = ?').all(userId);
  if (!accounts.length) return { ok: false, error: 'User has no Steam accounts linked. Add one in profile settings.' };

  const results = [];
  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0;
  const metadata = { queued: 0 };
  for (const acc of accounts) {
    const result = await syncSteamAccount(acc.id, opts);
    results.push({ account_id: acc.id, label: acc.label || 'Account', ...result });
    if (result.ok) {
      totalAdded += result.added || 0;
      totalUpdated += result.updated || 0;
      totalSkipped += result.skipped || 0;
      metadata.queued += result.metadata?.queued || 0;
    }
    // Be polite to Steam API between accounts
    if (accounts.length > 1) await new Promise(r => setTimeout(r, 500));
  }
  const anyOk = results.some(r => r.ok);
  return { ok: anyOk, added: totalAdded, updated: totalUpdated, skipped: totalSkipped, metadata, accounts: results };
}

// ---------- Express ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.debug(`${req.method} ${req.path} ${res.statusCode} ${Date.now()-start}ms`));
  next();
});

const requireSetup = (req, res, next) => isSetupComplete() ? next() : res.status(403).json({ error: 'Setup not complete' });

// ---------- Public ----------
app.get('/health', (req, res) => {
  res.json({ status:'ok', version:VERSION, setup_complete:isSetupComplete(),
    uptime_seconds:Math.floor(process.uptime()),
    db_users:db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    db_games:db.prepare('SELECT COUNT(*) AS c FROM games').get().c });
});
app.get('/api/setup/status', (req, res) => {
  // current_port is what the live HTTP server is actually listening on (may be a
  // boot-time fallback if the configured port was in use). suggested_port is what
  // the wizard pre-fills (the configured port, or the default). The wizard uses both
  // so it can warn the user "we're temporarily on X — pick a permanent port below".
  const cfg = loadConfig();
  let users = 0;
  try { users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c; } catch {}
  res.json({
    configured: isSetupComplete(),
    has_users: users > 0,
    user_count: users,
    current_port: ACTIVE_PORT || PORT,
    default_port: DEFAULT_PORT,
    suggested_port: cfg.port || DEFAULT_PORT,
    on_fallback_port: !!(ACTIVE_PORT && ACTIVE_PORT !== (cfg.port || DEFAULT_PORT)),
  });
});

app.post('/api/setup/test-steam', async (req, res) => {
  if (!req.body?.steam_api_key) return res.json({ ok:false, error:'API key required' });
  res.json(await testSteamKey(req.body.steam_api_key));
});
app.post('/api/setup/test-discord', async (req, res) => {
  const { discord_bot_token, discord_channel_id, send_message } = req.body || {};
  if (!discord_bot_token || !discord_channel_id) return res.json({ ok:false, error:'Bot token and channel ID required' });
  res.json(await testDiscord(discord_bot_token, discord_channel_id, !!send_message));
});
// First-run wizard — Part 1 (server setup) completion.
// Profile creation moved to Part 2 (/first-profile) so we can guide the user
// through Steam linking, library sync, and purchase-history imports properly.
// Legacy single-page fields (discord_bot_token, discord_channel_id, itad_api_key, group_name)
// remain accepted but optional, for a future Settings page.
app.post('/api/setup/complete', async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
  const body = req.body || {};
  const {
    steam_api_key, admin_password,
    hosting_mode, port,
    defaults,
    // legacy / optional
    group_name, discord_bot_token, discord_channel_id, itad_api_key
  } = body;

  if (!steam_api_key) return res.status(400).json({ error: 'Steam API key is required' });
  if (!admin_password) return res.status(400).json({ error: 'Admin password is required' });
  if (admin_password.length < 6) return res.status(400).json({ error: 'Admin password must be at least 6 characters' });

  // Validate the port if supplied. Ports below 1024 require admin/root on most OSes,
  // and 0/negative/>65535 aren't valid TCP ports — reject them with a friendly message.
  let chosenPort = null;
  if (port !== undefined && port !== null && String(port).trim() !== '') {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: 'Port must be a whole number between 1 and 65535' });
    }
    if (n < 1024) {
      return res.status(400).json({ error: 'Pick a port of 1024 or higher (lower ports usually need admin rights)' });
    }
    chosenPort = n;
  }

  // If the user is asking for a port different from the live one, prove it's bindable
  // BEFORE we save anything. Otherwise we'd save a port the server can't actually take,
  // close the working listener, and leave the app unreachable.
  if (chosenPort && chosenPort !== ACTIVE_PORT) {
    const available = await probePort(chosenPort);
    if (!available) {
      return res.status(400).json({
        error: `Port ${chosenPort} is already in use on this machine. Pick a different one.`,
      });
    }
  }

  const mode = hosting_mode === 'internet' ? 'internet' : 'local';

  try {
    db.transaction(() => {
      // Persist core server settings.
      setConfig('group_name', (group_name || 'The Backlog Ledger').toString().trim() || 'The Backlog Ledger');
      setConfig('steam_api_key', steam_api_key);
      setConfig('admin_password_hash', hashPassword(admin_password));
      setConfig('hosting_mode', mode);
      // Defaults — persisted now for a future Settings page. The current ledger logic
      // already treats zero-price games as free, so the toggle is informational for now.
      const currency = (defaults?.currency || 'GBP').toString().toUpperCase().slice(0, 8);
      setConfig('default_currency', currency);
      setConfig('treat_no_price_as_free', defaults?.free_no_price === false ? '0' : '1');
      if (defaults?.min_played_hours != null && Number.isFinite(Number(defaults.min_played_hours))) {
        setConfig('min_played_hours', String(Number(defaults.min_played_hours)));
      }
      // Optional legacy keys (a future Settings page can flesh these out).
      if (discord_bot_token) setConfig('discord_bot_token', discord_bot_token);
      if (discord_channel_id) setConfig('discord_channel_id', discord_channel_id);
      if (itad_api_key) setConfig('itad_api_key', itad_api_key);

      // Flip the first-run flag last so a crash mid-transaction leaves the wizard re-runnable.
      // The owner_user_id is set later when Part 2 creates the first profile.
      setConfig('setup_completed_at', String(Date.now()));
    })();
    // Persist the chosen port to config.json so future starts pick it up.
    let portWillSwap = false;
    if (chosenPort) {
      try {
        saveConfig({ port: chosenPort });
        portWillSwap = chosenPort !== ACTIVE_PORT;
      } catch (err) {
        logger.error('Failed to persist port to config.json', { error: err.message });
        return res.json({
          ok: true,
          port_save_error: 'Server is set up, but we could not save the port to config.json: ' + err.message,
          current_port: ACTIVE_PORT,
        });
      }
    }

    logger.info('Server setup completed (Part 1)', {
      hosting_mode: mode, port: chosenPort, port_will_swap: portWillSwap,
    });

    // Respond first, THEN swap the listener — so this very response makes it back to
    // the browser before the old socket is closed. The client uses port_will_swap and
    // chosen_port to redirect itself to the new URL after a short delay.
    res.json({
      ok: true,
      current_port: ACTIVE_PORT,
      chosen_port: chosenPort,
      port_will_swap: portWillSwap,
      next: '/first-profile',
    });

    if (portWillSwap) {
      // Give the response a moment to flush, then close the old listener and bind the new one.
      // We already proved chosenPort is bindable up top, so this should never fail —
      // but if it does, fall back to the previous port so the app stays reachable.
      const prevPort = ACTIVE_PORT;
      setTimeout(() => {
        logger.info('Swapping HTTP listener', { from: prevPort, to: chosenPort });
        httpServer.close((closeErr) => {
          if (closeErr) logger.warn('Error closing old listener', { error: closeErr.message });
          listenOnPort(httpServer, chosenPort)
            .then((actual) => {
              ACTIVE_PORT = actual;
              logger.info(`Server now listening on port ${actual}`);
            })
            .catch(async (err) => {
              logger.error('Failed to bind new port — falling back to previous', { error: err.message });
              try {
                const fallback = await listenOnPort(httpServer, prevPort);
                ACTIVE_PORT = fallback;
                logger.info(`Restored previous port ${fallback}`);
              } catch (fallbackErr) {
                logger.fatal('Could not restore listener — server is now unreachable', { error: fallbackErr.message });
              }
            });
        });
      }, 750);
    }
  } catch (err) {
    logger.error('Setup failed', { error: err.message });
    // Best-effort cleanup so the next attempt starts clean.
    try { deleteConfig('setup_completed_at'); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/group', (req, res) => res.json({ group_name: getConfig('group_name') || 'The Backlog Ledger', version: VERSION }));

// ---------- User profile routes (Phase 3) ----------
app.get('/api/users', requireSetup, (req, res) => {
  const rows = db.prepare(`SELECT id, display_name, steam_id, discord_user_id, avatar_url,
    created_at, last_synced_at FROM users ORDER BY display_name COLLATE NOCASE`).all();
  res.json({ users: rows });
});
app.get('/api/users/:id', requireSetup, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  res.json({ user: row });
});
app.post('/api/users/resolve-steam', requireSetup, async (req, res) => {
  if (!req.body?.steam_input) return res.json({ ok: false, error: 'Steam ID or vanity URL required' });
  res.json(await resolveSteamId(req.body.steam_input));
});
app.post('/api/users', requireSetup, async (req, res) => {
  const { display_name, steam_input, discord_user_id } = req.body || {};
  if (!display_name?.trim()) return res.status(400).json({ error: 'Display name required' });
  if (!steam_input) return res.status(400).json({ error: 'Steam ID required' });
  const resolved = await resolveSteamId(steam_input);
  if (!resolved.ok) return res.status(400).json({ error: 'Steam lookup failed: ' + resolved.error });
  const existing = db.prepare('SELECT id FROM users WHERE steam_id = ?').get(resolved.steam_id);
  if (existing) return res.status(409).json({ error: 'A profile with this Steam ID already exists' });
  const accDup = db.prepare('SELECT user_id FROM user_steam_accounts WHERE steam_id = ?').get(resolved.steam_id);
  if (accDup) return res.status(409).json({ error: 'This Steam ID is already linked to another profile' });
  try {
    let newId;
    db.transaction(() => {
      const info = db.prepare(`INSERT INTO users (display_name, steam_id, discord_user_id, avatar_url, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(display_name.trim(), resolved.steam_id,
        discord_user_id?.trim() || null, resolved.avatar_url || null, Date.now());
      newId = info.lastInsertRowid;
      db.prepare(`INSERT INTO user_steam_accounts (user_id, steam_id, label, persona_name, avatar_url, added_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(newId, resolved.steam_id, 'Main', resolved.persona_name || display_name.trim(),
        resolved.avatar_url || null, Date.now());
      // If no owner has been recorded yet (i.e. this is the first profile created
      // after Part 1 setup), claim ownership for this user. A future permissions
      // page can read owner_user_id without us having to backfill anything.
      if (!getConfig('owner_user_id')) setConfig('owner_user_id', String(newId));
    })();
    logger.info('Profile created', { id: newId, name: display_name });
    res.json({ ok: true, id: newId, steam_id: resolved.steam_id, avatar_url: resolved.avatar_url });
  } catch (err) { logger.error('Create profile failed', { error: err.message }); res.status(500).json({ error: err.message }); }
});
app.patch('/api/users/:id', requireSetup, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Profile not found' });
  const { display_name, steam_input, discord_user_id } = req.body || {};
  let steam_id = user.steam_id, avatar_url = user.avatar_url;
  let resolvedPersona = null;
  if (steam_input && steam_input !== user.steam_id) {
    const resolved = await resolveSteamId(steam_input);
    if (!resolved.ok) return res.status(400).json({ error: 'Steam lookup failed: ' + resolved.error });
    if (resolved.steam_id !== user.steam_id) {
      const dup = db.prepare('SELECT id FROM users WHERE steam_id = ? AND id != ?').get(resolved.steam_id, user.id);
      if (dup) return res.status(409).json({ error: 'Another profile already uses this Steam ID' });
      const accDup = db.prepare('SELECT user_id FROM user_steam_accounts WHERE steam_id = ? AND user_id != ?').get(resolved.steam_id, user.id);
      if (accDup) return res.status(409).json({ error: 'This Steam ID is already linked to another profile' });
    }
    steam_id = resolved.steam_id;
    avatar_url = resolved.avatar_url || avatar_url;
    resolvedPersona = resolved.persona_name;
  }
  try {
    db.transaction(() => {
      db.prepare(`UPDATE users SET display_name = ?, steam_id = ?, discord_user_id = ?, avatar_url = ? WHERE id = ?`)
        .run(display_name?.trim() || user.display_name, steam_id, discord_user_id?.trim() || null, avatar_url, user.id);

      // Sync the primary account row
      if (steam_id) {
        const primaryAcc = db.prepare(`SELECT id FROM user_steam_accounts WHERE user_id = ? ORDER BY added_at ASC LIMIT 1`).get(user.id);
        if (primaryAcc) {
          db.prepare(`UPDATE user_steam_accounts SET steam_id = ?, persona_name = COALESCE(?, persona_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`)
            .run(steam_id, resolvedPersona, avatar_url, primaryAcc.id);
        } else {
          db.prepare(`INSERT INTO user_steam_accounts (user_id, steam_id, label, persona_name, avatar_url, added_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, steam_id, 'Main', resolvedPersona || display_name || user.display_name, avatar_url, Date.now());
        }
      }
    })();
    logger.info('Profile updated', { id: user.id });
    res.json({ ok: true });
  } catch (err) { logger.error('Update profile failed', { error: err.message }); res.status(500).json({ error: err.message }); }
});
app.delete('/api/users/:id', requireSetup, (req, res) => {
  if (!verifyPassword(req.headers['x-admin-password'])) return res.status(401).json({ error: 'Admin password required' });
  try {
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Profile not found' });
    logger.info('Profile deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) { logger.error('Delete failed', { error: err.message }); res.status(500).json({ error: err.message }); }
});

// ---------- Steam account management ----------
// List all Steam accounts linked to a profile
app.get('/api/users/:id/steam-accounts', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Profile not found' });
  const accounts = db.prepare(`SELECT id, steam_id, label, persona_name, avatar_url, added_at, last_synced_at
    FROM user_steam_accounts WHERE user_id = ? ORDER BY added_at ASC`).all(userId);
  res.json({ ok: true, accounts });
});

// Add a new Steam account to a profile
app.post('/api/users/:id/steam-accounts', requireSetup, async (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Profile not found' });
  const { steam_input, label } = req.body || {};
  if (!steam_input) return res.status(400).json({ error: 'Steam ID or vanity URL required' });
  const resolved = await resolveSteamId(steam_input);
  if (!resolved.ok) return res.status(400).json({ error: 'Steam lookup failed: ' + resolved.error });

  // Check the Steam ID isn't already used by anyone
  const dupAcc = db.prepare('SELECT user_id FROM user_steam_accounts WHERE steam_id = ?').get(resolved.steam_id);
  if (dupAcc) return res.status(409).json({ error: 'This Steam ID is already linked to a profile' });
  const dupUser = db.prepare('SELECT id FROM users WHERE steam_id = ? AND id != ?').get(resolved.steam_id, userId);
  if (dupUser) return res.status(409).json({ error: 'This Steam ID is the primary account of another profile' });

  try {
    const cleanLabel = (label || resolved.persona_name || 'Account').toString().trim().slice(0, 50);
    const info = db.prepare(`INSERT INTO user_steam_accounts (user_id, steam_id, label, persona_name, avatar_url, added_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(userId, resolved.steam_id, cleanLabel,
      resolved.persona_name || null, resolved.avatar_url || null, Date.now());
    logger.info('Steam account added', { user_id: userId, account_id: info.lastInsertRowid, steam_id: resolved.steam_id });
    res.json({ ok: true, account_id: info.lastInsertRowid, steam_id: resolved.steam_id, persona_name: resolved.persona_name, avatar_url: resolved.avatar_url, label: cleanLabel });
  } catch (err) {
    logger.error('Add Steam account failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Rename / update label of a Steam account
app.patch('/api/users/:id/steam-accounts/:accountId', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const accountId = parseInt(req.params.accountId);
  const account = db.prepare('SELECT * FROM user_steam_accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
  if (!account) return res.status(404).json({ error: 'Steam account not found' });
  const { label } = req.body || {};
  if (label === undefined || label === null) return res.status(400).json({ error: 'Label required' });
  const cleanLabel = String(label).trim().slice(0, 50);
  if (!cleanLabel) return res.status(400).json({ error: 'Label cannot be empty' });
  db.prepare('UPDATE user_steam_accounts SET label = ? WHERE id = ?').run(cleanLabel, accountId);
  logger.info('Steam account renamed', { user_id: userId, account_id: accountId, label: cleanLabel });
  res.json({ ok: true });
});

// Remove a Steam account. Requires admin password. Removes its associated games.
app.delete('/api/users/:id/steam-accounts/:accountId', requireSetup, (req, res) => {
  if (!verifyPassword(req.headers['x-admin-password'])) return res.status(401).json({ error: 'Admin password required' });
  const userId = parseInt(req.params.id);
  const accountId = parseInt(req.params.accountId);
  const account = db.prepare('SELECT * FROM user_steam_accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
  if (!account) return res.status(404).json({ error: 'Steam account not found' });

  // Don't allow removing the only account
  const totalAccounts = db.prepare('SELECT COUNT(*) AS c FROM user_steam_accounts WHERE user_id = ?').get(userId).c;
  if (totalAccounts <= 1) return res.status(400).json({ error: 'Cannot remove the only Steam account. Delete the profile instead.' });

  try {
    db.transaction(() => {
      // Delete games tied exclusively to this account
      db.prepare(`DELETE FROM user_games WHERE user_id = ? AND steam_account_id = ?`).run(userId, accountId);
      db.prepare(`DELETE FROM user_steam_accounts WHERE id = ?`).run(accountId);

      // If this was the primary account, promote the next-oldest one
      const user = db.prepare('SELECT steam_id FROM users WHERE id = ?').get(userId);
      if (user?.steam_id === account.steam_id) {
        const next = db.prepare(`SELECT steam_id, avatar_url FROM user_steam_accounts WHERE user_id = ? ORDER BY added_at ASC LIMIT 1`).get(userId);
        if (next) {
          db.prepare(`UPDATE users SET steam_id = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?`).run(next.steam_id, next.avatar_url, userId);
        }
      }
    })();
    logger.info('Steam account removed', { user_id: userId, account_id: accountId, steam_id: account.steam_id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Remove Steam account failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Sync just one specific Steam account
app.post('/api/users/:id/steam-accounts/:accountId/sync', requireSetup, async (req, res) => {
  const userId = parseInt(req.params.id);
  const accountId = parseInt(req.params.accountId);
  const account = db.prepare('SELECT id FROM user_steam_accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
  if (!account) return res.status(404).json({ error: 'Steam account not found' });
  try {
    const result = await syncSteamAccount(accountId, { refreshMetadata: !!req.body?.refresh_metadata });
    res.json(result);
  } catch (err) {
    logger.error('Single account sync failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- PHASE 4: Sync routes ----------
app.post('/api/users/:id/sync', requireSetup, async (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT last_synced_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Profile not found' });

  // Server-side rate limit
  if (user.last_synced_at && Date.now() - user.last_synced_at < SYNC_RATE_LIMIT_MS) {
    const wait = Math.ceil((SYNC_RATE_LIMIT_MS - (Date.now() - user.last_synced_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before syncing again` });
  }

  const result = await syncUserLibrary(userId, { refreshMetadata: !!req.body?.refresh_metadata });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/users/:id/games', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  // Load all Steam accounts for this user (for the badge data)
  const accounts = db.prepare(`SELECT id, label, steam_id FROM user_steam_accounts WHERE user_id = ?`).all(userId);
  const accountById = new Map();
  for (const a of accounts) accountById.set(a.id, a);

  // Load raw rows (may have duplicates across accounts)
  const raw = db.prepare(`SELECT g.app_id, g.name, g.genres_json, g.categories_json,
    g.steam_metadata_last_synced_at, ug.playtime_minutes, ug.playtime_last_2weeks,
    ug.paid_price_cents, ug.play_status, ug.manual_override, ug.completed_at, ug.notes,
    COALESCE(ug.price_is_estimated, 0) AS price_is_estimated,
    ug.price_estimate_source, ug.steam_account_id
    FROM user_games ug JOIN games g ON g.app_id = ug.app_id
    WHERE ug.user_id = ?
    ORDER BY ug.playtime_minutes DESC, g.name COLLATE NOCASE`).all(userId);

  // Aggregate by app_id — same game on multiple accounts merges into one row.
  // Hours and price are SUMMED (you played 55h total across accounts, you spent £40 total).
  // A game is settled when total hours ≥ total price, regardless of which account played/paid.
  const byAppId = new Map();
  for (const r of raw) {
    const accLabel = r.steam_account_id ? accountById.get(r.steam_account_id)?.label : null;
    const accBreakdownEntry = {
      account_id: r.steam_account_id,
      label: accLabel || 'Unassigned',
      hours: Math.round(((r.playtime_minutes || 0) / 60) * 10) / 10,
      price_cents: r.paid_price_cents || 0,
    };
    const existing = byAppId.get(r.app_id);
    if (!existing) {
      byAppId.set(r.app_id, {
        ...r,
        genres: parseJsonArray(r.genres_json),
        categories: parseJsonArray(r.categories_json),
        steamMetadataLastSyncedAt: r.steam_metadata_last_synced_at ? new Date(r.steam_metadata_last_synced_at).toISOString() : null,
        genres_json: undefined,
        categories_json: undefined,
        steam_metadata_last_synced_at: undefined,
        steam_accounts: accLabel ? [{ id: r.steam_account_id, label: accLabel }] : [],
        account_breakdown: [accBreakdownEntry],
      });
    } else {
      // SUM hours and price across accounts
      existing.playtime_minutes = (existing.playtime_minutes || 0) + (r.playtime_minutes || 0);
      existing.playtime_last_2weeks = (existing.playtime_last_2weeks || 0) + (r.playtime_last_2weeks || 0);
      existing.paid_price_cents = (existing.paid_price_cents || 0) + (r.paid_price_cents || 0);
      // If ANY contributing row is estimated, mark the merged row as estimated (so the user knows)
      if (r.price_is_estimated) {
        existing.price_is_estimated = 1;
        if (r.price_estimate_source && !existing.price_estimate_source) {
          existing.price_estimate_source = r.price_estimate_source;
        }
      }
      existing.manual_override = existing.manual_override || r.manual_override;
      // Status priority: completed > exempt > free > anything else
      if (r.play_status === 'completed' || existing.play_status === 'completed') existing.play_status = 'completed';
      else if (r.play_status === 'exempt' || existing.play_status === 'exempt') existing.play_status = 'exempt';
      else if (r.play_status === 'free' || existing.play_status === 'free') existing.play_status = 'free';
      if (r.notes && !existing.notes) existing.notes = r.notes;
      if (r.completed_at && !existing.completed_at) existing.completed_at = r.completed_at;
      if (r.steam_account_id) {
        if (accLabel && !existing.steam_accounts.some(a => a.id === r.steam_account_id)) {
          existing.steam_accounts.push({ id: r.steam_account_id, label: accLabel });
        }
      }
      existing.account_breakdown.push(accBreakdownEntry);
    }
  }
  const rows = applyMergeGroupsToGameMap(userId, byAppId, { gotwPicks: getCurrentGotWPicks() });

  // Compute "contract" stats per the original Ledger's model
  let totalSpent = 0, totalHours = 0, totalDebt = 0;
  const counts = { all: rows.length, contracts: 0, paid: 0, arrears: 0, outstanding: 0, free: 0, exempt: 0 };
  for (const r of rows) {
    const hours = (r.playtime_minutes || 0) / 60;
    const price = (r.paid_price_cents || 0) / 100;
    totalHours += hours;
    if (r.play_status === 'exempt') { counts.exempt++; continue; }
    if (price === 0) { counts.free++; continue; }
    totalSpent += price;
    counts.contracts++;
    if (r.play_status === 'completed' || r.completed_at) { counts.paid++; continue; }
    const debt = Math.max(0, price - hours);
    totalDebt += debt;
    if (hours >= price) counts.paid++;
    else if (hours > 0) counts.arrears++;
    else counts.outstanding++;
  }

  res.json({
    games: rows,
    accounts,
    stats: {
      total: rows.length,
      played: rows.filter(r => r.playtime_minutes > 0).length,
      unplayed: rows.filter(r => r.playtime_minutes === 0).length,
      total_hours: Math.round(totalHours),
      total_spent_pounds: Math.round(totalSpent * 100) / 100,
      total_debt_pounds: Math.round(totalDebt * 100) / 100,
      avg_price_per_hour: totalHours > 0 ? Math.round((totalSpent / totalHours) * 100) / 100 : null,
      counts,
    }
  });
});

app.get('/api/users/:id/merge-groups', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Profile not found' });
  res.json({ ok: true, merge_groups: getMergedGamesForPlayer(userId) });
});

function normaliseMergeAppIds(raw) {
  return [...new Set((raw || []).map(Number).filter(id => Number.isInteger(id)))];
}

function validateMergeApps(userId, appIds, groupId = null) {
  if (appIds.length < 2) return 'Choose at least two games to merge';
  const placeholders = appIds.map(() => '?').join(',');
  const owned = db.prepare(`SELECT DISTINCT app_id FROM user_games WHERE user_id = ? AND app_id IN (${placeholders})`)
    .all(userId, ...appIds).map(r => r.app_id);
  if (owned.length !== appIds.length) return 'Every merged game must already be in this player library';
  const existing = db.prepare(`SELECT app_id, group_id FROM game_merge_members
    WHERE user_id = ? AND app_id IN (${placeholders})`).all(userId, ...appIds);
  const conflict = existing.find(r => !groupId || r.group_id !== groupId);
  if (conflict) return `App ${conflict.app_id} is already in another merge group`;
  return null;
}

app.post('/api/users/:id/merge-groups', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Profile not found' });
  const appIds = normaliseMergeAppIds(req.body?.appIds || req.body?.mergedAppIds);
  const primaryAppId = Number(req.body?.primaryAppId || req.body?.primary_app_id || appIds[0]);
  if (!appIds.includes(primaryAppId)) return res.status(400).json({ error: 'Primary game must be in the merge group' });
  const validation = validateMergeApps(userId, appIds);
  if (validation) return res.status(400).json({ error: validation });

  const now = new Date().toISOString();
  const id = `merge_${crypto.randomBytes(8).toString('hex')}`;
  db.transaction(() => {
    db.prepare(`INSERT INTO game_merge_groups (id, user_id, primary_app_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, userId, primaryAppId, now, now);
    const add = db.prepare('INSERT INTO game_merge_members (group_id, user_id, app_id) VALUES (?, ?, ?)');
    for (const appId of appIds) add.run(id, userId, appId);
  })();
  logger.info('Game merge group created', { user_id: userId, group_id: id, primary_app_id: primaryAppId, app_ids: appIds });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'merge_group_create');
  res.json({ ok: true, merge_group: serialiseMergeGroup(db.prepare('SELECT * FROM game_merge_groups WHERE id = ?').get(id)) });
});

app.patch('/api/users/:id/merge-groups/:groupId', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const groupId = req.params.groupId;
  const group = db.prepare('SELECT * FROM game_merge_groups WHERE id = ? AND user_id = ?').get(groupId, userId);
  if (!group) return res.status(404).json({ error: 'Merge group not found' });

  const currentIds = db.prepare('SELECT app_id FROM game_merge_members WHERE group_id = ? ORDER BY app_id').all(groupId).map(r => r.app_id);
  let nextIds = currentIds.slice();
  if (req.body?.addAppId !== undefined) nextIds = [...new Set([...nextIds, Number(req.body.addAppId)])];
  if (req.body?.removeAppId !== undefined) nextIds = nextIds.filter(id => id !== Number(req.body.removeAppId));
  if (Array.isArray(req.body?.appIds) || Array.isArray(req.body?.mergedAppIds)) {
    nextIds = normaliseMergeAppIds(req.body.appIds || req.body.mergedAppIds);
  }

  if (nextIds.length < 2) {
    db.transaction(() => {
      db.prepare('DELETE FROM game_merge_members WHERE group_id = ?').run(groupId);
      db.prepare('DELETE FROM game_merge_groups WHERE id = ?').run(groupId);
    })();
    logger.info('Game merge group dissolved', { user_id: userId, group_id: groupId });
    if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'merge_group_dissolve');
    return res.json({ ok: true, dissolved: true });
  }

  let primaryAppId = req.body?.primaryAppId !== undefined ? Number(req.body.primaryAppId) : group.primary_app_id;
  if (!nextIds.includes(primaryAppId)) primaryAppId = nextIds[0];
  const validation = validateMergeApps(userId, nextIds, groupId);
  if (validation) return res.status(400).json({ error: validation });

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE game_merge_groups SET primary_app_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(primaryAppId, now, groupId, userId);
    db.prepare('DELETE FROM game_merge_members WHERE group_id = ?').run(groupId);
    const add = db.prepare('INSERT INTO game_merge_members (group_id, user_id, app_id) VALUES (?, ?, ?)');
    for (const appId of nextIds) add.run(groupId, userId, appId);
  })();
  logger.info('Game merge group updated', { user_id: userId, group_id: groupId, primary_app_id: primaryAppId, app_ids: nextIds });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'merge_group_update');
  res.json({ ok: true, merge_group: serialiseMergeGroup(db.prepare('SELECT * FROM game_merge_groups WHERE id = ?').get(groupId)) });
});

app.delete('/api/users/:id/merge-groups/:groupId', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const groupId = req.params.groupId;
  const result = db.prepare('DELETE FROM game_merge_groups WHERE id = ? AND user_id = ?').run(groupId, userId);
  if (!result.changes) return res.status(404).json({ error: 'Merge group not found' });
  logger.info('Game merge group deleted', { user_id: userId, group_id: groupId });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'merge_group_delete');
  res.json({ ok: true });
});

// PATCH an individual game's per-user fields
app.patch('/api/users/:id/games/:appId', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const appId = parseInt(req.params.appId);
  const existing = getCanonicalUserGame(userId, appId);
  if (!existing) return res.status(404).json({ error: 'Game not in user library' });

  const { paid_price_cents, playtime_minutes, play_status, notes, manual_override, completed } = req.body || {};
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM user_games WHERE user_id = ? AND app_id = ?').get(userId, appId).c;
  if (playtime_minutes !== undefined && rowCount > 1) {
    return res.status(400).json({
      error: 'Manual playtime edits are disabled for games merged from multiple Steam accounts. Sync the account playtime instead.'
    });
  }
  const updates = [];
  const params = [];
  const cleanup = { price: false, status: false, notes: false };

  if (paid_price_cents !== undefined) {
    if (paid_price_cents !== null && (paid_price_cents < 0 || !Number.isFinite(paid_price_cents))) return res.status(400).json({ error: 'Invalid price' });
    const nextPrice = paid_price_cents === null ? null : Math.round(paid_price_cents);
    updates.push('paid_price_cents = ?'); params.push(nextPrice);
    updates.push('price_is_estimated = ?'); params.push(0);
    updates.push('price_estimate_source = ?'); params.push(null);
    cleanup.price = true;

    // If a user manually types in a real price for something previously marked
    // Free/Gifted/Complimentary, it should rejoin the normal ledger flow.
    // Explicit status changes still win below, but plain price editing should
    // clear the old free tag automatically.
    if (nextPrice && nextPrice > 0 && play_status === undefined && existing.play_status === 'free') {
      updates.push('play_status = ?'); params.push('unplayed');
    }
  }
  if (playtime_minutes !== undefined) {
    if (playtime_minutes < 0 || !Number.isFinite(playtime_minutes)) return res.status(400).json({ error: 'Invalid playtime' });
    updates.push('playtime_minutes = ?'); params.push(Math.round(playtime_minutes));
    // Setting playtime manually = lock it
    updates.push('manual_override = ?'); params.push(1);
  }
  if (play_status !== undefined) {
    const valid = ['unplayed', 'playing', 'completed', 'exempt', 'free'];
    if (!valid.includes(play_status)) return res.status(400).json({ error: 'Invalid status' });
    updates.push('play_status = ?'); params.push(play_status);
    cleanup.status = true;
  }
  if (notes !== undefined) {
    updates.push('notes = ?'); params.push(notes || null);
    cleanup.notes = true;
  }
  if (manual_override !== undefined) {
    updates.push('manual_override = ?'); params.push(manual_override ? 1 : 0);
  }
  if (completed !== undefined) {
    updates.push('completed_at = ?'); params.push(completed ? Date.now() : null);
    cleanup.status = true;
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(userId, appId, accountKey(existing.steam_account_id));
  db.transaction(() => {
    db.prepare(`UPDATE user_games SET ${updates.join(', ')}
      WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`).run(...params);
    clearDuplicateLedgerFields(userId, appId, existing.steam_account_id, cleanup);
  })();
  logger.info('Game updated', { user_id: userId, app_id: appId, fields: Object.keys(req.body) });

  // Check if this game was the user's personal GotW — if now paid/completed, auto-reroll
  try {
    const gotw = getCurrentGotWPicks();
    // personal_picks keys may be strings (JSON) — match against both
    const currentPersonalPick = gotw?.personal_picks?.[userId] ?? gotw?.personal_picks?.[String(userId)];
    if (currentPersonalPick && isGameInSameMergeGroup(userId, currentPersonalPick, appId)) {
      const rows = getEffectiveLedgerEntriesForPlayer(userId, { gotwPicks: gotw });
      const effective = rows.find(r => Number(r.app_id) === Number(currentPersonalPick) ||
        (Array.isArray(r.merged_app_ids) && r.merged_app_ids.map(Number).includes(Number(currentPersonalPick))));
      if (effective) {
        const settled = !isUnpaidContractRow(effective);
        if (settled) {
          const unpaid = rows
            .filter(r => isUnpaidContractRow(r))
            .filter(r => !isGameInSameMergeGroup(userId, r.app_id, currentPersonalPick))
            .map(r => r.app_id);
          // Exclude group GotW
          let pool = unpaid.filter(id => !isGameInSameMergeGroup(userId, id, gotw.group_app_id));
          if (!pool.length) pool = unpaid;
          if (pool.length) {
            const newPick = pool[Math.floor(Math.random() * pool.length)];
            const personal = { ...(gotw.personal_picks || {}), [userId]: newPick };
            const now = Date.now();
            const weekStart = now - (now % (7 * 24 * 3600 * 1000));
            db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
              VALUES (?, ?, ?, ?)`).run(weekStart, gotw.group_app_id, JSON.stringify(personal), now);
            const newGame = db.prepare('SELECT name FROM games WHERE app_id = ?').get(newPick);
            logger.info('Personal GotW auto-rerolled (previous game settled)', { user_id: userId, old_app_id: currentPersonalPick, settled_app_id: appId, new_app_id: newPick, new_name: newGame?.name });
          }
        }
      }
    }
  } catch (err) { logger.error('GotW auto-reroll check failed', { error: err.message }); }

  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'game_update');
  res.json({ ok: true });
});

app.get('/api/users/:id/sync-log', requireSetup, (req, res) => {
  const rows = db.prepare(`SELECT synced_at, games_added, games_updated, status, error_message
    FROM sync_log WHERE user_id = ? ORDER BY synced_at DESC LIMIT 10`).all(req.params.id);
  res.json({ entries: rows });
});

// ---------- PHASE 5: Purchase history parser (ported from original Backlog Ledger) ----------

// Normalise for lookup: lowercase, strip trademark, collapse whitespace.
// Used ONLY for the match-key. Display name is preserved as-is.
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Single-pass parser based on the original Backlog Ledger.
function parsePurchaseHistory(text) {
  const dateRe = /^\s*(\d{1,2}\s+\w+,?\s+\d{4})\b/;
  const typeRe = /^(Purchase|Refund|Gift Purchase|In-Game Purchase)\s*$/i;
  const giftMetaRe = /^Gift sent to/i;
  const paymentRe = /^(Visa|MasterCard|PayPal|Retail|Discover|Amex|Steam Wallet|Wallet$|£[\d,]+(?:\.\d+)?\s+(?:Wallet|Visa|MasterCard|PayPal))/i;
  const discountRe = /^-?\d+%\s*$/;
  const strikethroughRe = /^£[\d,]+(?:\.\d+)?\s+£([\d,]+(?:\.\d+)?)\s*$/;
  const singlePriceRe = /^£([\d,]+(?:\.\d+)?)\s*$/;
  const walletCreditRe = /Wallet Credit/i;

  const transactions = [];
  let current = null;
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    const dm = dateRe.exec(trimmed);
    if (dm) {
      if (current) transactions.push(current);
      current = { date: dm[1], items: [], type: null, finalPrice: null, giftTo: null, isWalletCredit: false };
      const after = trimmed.substring(dm[0].length).replace(/\t/g, ' ').trim();
      if (after) {
        if (walletCreditRe.test(after)) current.isWalletCredit = true;
        else current.items.push(after);
      }
      continue;
    }

    if (!current) continue;

    const tm = typeRe.exec(trimmed);
    if (tm) { current.type = tm[1]; continue; }

    if (current.type) {
      // After type: find the total. First detection wins.
      // Skip partial-payment lines like "£4.00 Wallet" or "£4.74 Visa **02"
      if (/^£[\d,]+(?:\.\d+)?\s+(?:Wallet|Visa|MasterCard|PayPal|Retail|Discover|Amex|Steam)\b/i.test(trimmed)) continue;
      if (current.finalPrice === null) {
        let m;
        if ((m = strikethroughRe.exec(trimmed))) {
          current.finalPrice = parseFloat(m[1].replace(/,/g, ''));
        } else if ((m = singlePriceRe.exec(trimmed))) {
          current.finalPrice = parseFloat(m[1].replace(/,/g, ''));
        } else {
          const firstMatch = trimmed.match(/^£([\d,]+(?:\.\d+)?)\b/);
          if (firstMatch && /[\s\t]/.test(trimmed.substring(firstMatch[0].length))) {
            current.finalPrice = parseFloat(firstMatch[1].replace(/,/g, ''));
          }
        }
      }
    } else {
      // Before type: filter non-item lines
      if (giftMetaRe.test(trimmed)) {
        current.giftTo = trimmed.replace(/^Gift sent to\s*/i, '').trim();
        continue;
      }
      if (paymentRe.test(trimmed)) continue;
      if (discountRe.test(trimmed)) continue;
      if (strikethroughRe.test(trimmed) || singlePriceRe.test(trimmed)) continue;
      if (walletCreditRe.test(trimmed)) { current.isWalletCredit = true; continue; }
      current.items.push(trimmed);
    }
  }
  if (current) transactions.push(current);
  return transactions;
}

// Aggregate transactions into a per-game map.
// Bundle prices split equally across items. Same-name purchases ACCUMULATE.
function aggregatePurchases(transactions) {
  const map = new Map(); // normKey → { name, total, count, multiBundle, refunded, gifts }
  const stats = { totalTx: transactions.length, purchases: 0, refunds: 0, gifts: 0, walletCredits: 0,
                  multiGame: 0, singleGame: 0, totalSpent: 0, refundedNames: [] };

  for (const tx of transactions) {
    if (tx.isWalletCredit) { stats.walletCredits++; continue; }
    if (!tx.type) continue;
    if (/Refund/i.test(tx.type)) {
      stats.refunds++;
      for (const item of tx.items) stats.refundedNames.push(normKey(item));
      continue;
    }
    if (/Gift Purchase/i.test(tx.type)) {
      stats.gifts++;
      for (const item of tx.items) {
        const key = normKey(item);
        if (!map.has(key)) map.set(key, { name: item, total: 0, count: 0, multiBundle: false, refunded: false, gifts: [] });
        map.get(key).gifts.push({ to: tx.giftTo, amount: tx.finalPrice });
      }
      continue;
    }
    if (!/Purchase$|^In-Game Purchase/i.test(tx.type)) continue;
    if (tx.finalPrice === null || tx.finalPrice === undefined) continue;
    if (tx.items.length === 0) continue;

    const items = tx.items.filter(it => !/Wallet Credit/i.test(it));
    if (items.length === 0) continue;
    if (/In-Game Purchase/i.test(tx.type)) continue; // skip super credits etc.

    stats.purchases++;
    stats.totalSpent += tx.finalPrice;
    if (items.length === 1) stats.singleGame++;
    else stats.multiGame++;

    const each = tx.finalPrice / items.length;
    for (const item of items) {
      const key = normKey(item);
      if (!map.has(key)) map.set(key, { name: item, total: 0, count: 0, multiBundle: false, refunded: false, gifts: [] });
      const entry = map.get(key);
      entry.total += each;
      entry.count += 1;
      if (items.length > 1) entry.multiBundle = true;
    }
  }

  // Mark refunded entries (they appear in refundedNames AND in purchases map)
  for (const refundedName of stats.refundedNames) {
    if (map.has(refundedName)) {
      const entry = map.get(refundedName);
      entry.refunded = true;
      entry.total = 0; // refunded
    }
  }

  return { map, stats };
}

// Match aggregated entries against the user's library.
// Three-stage matching, all DETERMINISTIC (no fuzzy scores):
//   1. Exact normKey match
//   2. Simplified key match (strip edition suffixes, regional tags)
//   3. Substring containment (one name fully contains the other)
function simplifyKey(s) {
  return normKey(s)
    .replace(/\s*[:\-–—]\s+.+$/, '')  // strip everything after a colon or dash
    .replace(/\s*\([^)]*\)\s*/g, ' ') // strip parenthesised content
    .replace(/\b(standard|deluxe|ultimate|complete|definitive|enhanced|remastered|edition|pack|bundle|goty|gold|platinum|collection|launch|legacy|classic|game of the year|anniversary|preorder|pre-purchase|row|ww|uk|eu)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function matchAgainstLibrary(userId, aggregateMap) {
  const libRows = db.prepare(`SELECT DISTINCT g.app_id, g.name FROM games g
    JOIN user_games ug ON ug.app_id = g.app_id WHERE ug.user_id = ?`).all(userId);

  // Pre-load learned overrides for this user (stage 0 of matching).
  // Maps lowercased receipt name → app_id from a prior manual match.
  const overrides = new Map();
  const overrideRows = db.prepare('SELECT raw_name_lc, app_id FROM match_overrides WHERE user_id = ?').all(userId);
  for (const r of overrideRows) overrides.set(r.raw_name_lc, r.app_id);
  // Library by app_id for override lookup
  const libByAppId = new Map();
  for (const g of libRows) libByAppId.set(g.app_id, g);

  // Three lookups, prioritised in order
  const exact = new Map();      // normKey → lib
  const simplified = new Map(); // simplifyKey → lib
  for (const g of libRows) {
    exact.set(normKey(g.name), g);
    const sk = simplifyKey(g.name);
    if (sk && !simplified.has(sk)) simplified.set(sk, g);
  }

  function findMatch(rawName) {
    // Stage 0: learned override from a prior manual match
    const lc = String(rawName || '').toLowerCase().trim();
    if (overrides.has(lc)) {
      const appId = overrides.get(lc);
      const g = libByAppId.get(appId);
      if (g) return { ...g, _learned: true };
    }
    // Stage 1: exact normalised match
    const ek = normKey(rawName);
    if (exact.has(ek)) return exact.get(ek);
    // Stage 2: simplified match
    const sk = simplifyKey(rawName);
    if (sk && simplified.has(sk)) return simplified.get(sk);
    // Stage 3: substring containment with ≥2 shared meaningful tokens
    if (sk) {
      const tokens = sk.split(' ').filter(t => t.length > 2);
      if (tokens.length < 2) return null;
      for (const [libKey, libGame] of simplified.entries()) {
        if (libKey.length < 4) continue;
        if (sk.includes(libKey) || libKey.includes(sk)) {
          const libTokens = libKey.split(' ').filter(t => t.length > 2);
          let shared = 0;
          for (const t of tokens) if (libTokens.includes(t)) shared++;
          if (shared >= 2) return libGame;
        }
      }
    }
    return null;
  }

  const results = [];
  for (const [, entry] of aggregateMap.entries()) {
    if (entry.refunded) {
      results.push({
        raw_name: entry.name, total_cents: 0, count: entry.count,
        multi_bundle: entry.multiBundle, skip: true,
        skip_reason: 'Refunded — net £0',
        match: null, needs_manual_match: false,
      });
      continue;
    }
    if (entry.total === 0 && entry.gifts && entry.gifts.length > 0) {
      results.push({
        raw_name: entry.name, total_cents: 0,
        skip: true, skip_reason: `Only gifted (to ${entry.gifts.map(g => g.to).join(', ')}) — not in your library`,
        match: null, needs_manual_match: false,
      });
      continue;
    }
    if (entry.total === 0) continue;

    const lib = findMatch(entry.name);
    if (!lib) {
      logger.debug('No library match', { receipt: entry.name, simplified: simplifyKey(entry.name) });
    }
    results.push({
      raw_name: entry.name,
      total_cents: Math.round(entry.total * 100),
      count: entry.count,
      multi_bundle: entry.multiBundle,
      gifts: entry.gifts || [],
      skip: false,
      match: lib ? { app_id: lib.app_id, name: lib.name } : null,
      needs_manual_match: !lib,
    });
  }
  return results;
}

function getLibraryGamesByIds(userId, appIds) {
  const ids = [...new Set((appIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT g.app_id, g.name FROM games g
    JOIN user_games ug ON ug.app_id = g.app_id
    WHERE ug.user_id = ? AND g.app_id IN (${placeholders})`)
    .all(userId, ...ids);
}

function applySavedImportDecisions(userId, importKind, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const decisionRows = db.prepare('SELECT raw_name_lc, action, app_ids_json, custom_name FROM import_decisions WHERE user_id = ? AND import_kind = ?')
    .all(userId, importKind);
  const decisions = new Map(decisionRows.map(r => [r.raw_name_lc, r]));
  for (const row of rows) {
    const key = String(row.raw_name || '').toLowerCase().trim();
    if (!key || !decisions.has(key)) continue;
    const d = decisions.get(key);
    // Preserve system skips such as refunds/outgoing gifts unless the user is actively managing a licence row.
    if (row.skip && importKind !== 'license') continue;

    row.skip = false;
    row.skip_reason = null;
    row.override_app_id = null;
    row.override_name = null;
    row.bundle_app_ids = null;
    row.bundle_names = null;
    row.custom_name = null;
    row.link_dlc = false;

    if (d.action === 'ignore') {
      row.skip = true;
      row.skip_reason = 'No match needed';
      row.match = null;
      continue;
    }
    if (d.action === 'pending') {
      row.custom_name = d.custom_name || row.raw_name;
      row.match = null;
      continue;
    }
    let appIds = [];
    try { appIds = JSON.parse(d.app_ids_json || '[]'); } catch { appIds = []; }
    const games = getLibraryGamesByIds(userId, appIds);
    if (!games.length) continue;
    if (d.action === 'bundle' && games.length > 1) {
      row.match = null;
      row.bundle_app_ids = games.map(g => g.app_id);
      row.bundle_names = games.map(g => g.name);
    } else {
      const g = games[0];
      row.override_app_id = g.app_id;
      row.override_name = g.name;
      row.match = { app_id: g.app_id, name: g.name, _learned: true };
    }
  }
  return rows;
}

function saveImportDecision(userId, importKind, rawName, action, appIds = [], customName = null) {
  const key = String(rawName || '').toLowerCase().trim();
  if (!key) return;
  db.prepare(`INSERT INTO import_decisions (user_id, import_kind, raw_name_lc, action, app_ids_json, custom_name, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, import_kind, raw_name_lc) DO UPDATE SET
      action=excluded.action,
      app_ids_json=excluded.app_ids_json,
      custom_name=excluded.custom_name,
      saved_at=excluded.saved_at`)
    .run(userId, importKind, key, action, JSON.stringify((appIds || []).map(Number).filter(Boolean)), customName || null, Date.now());
}

function forgetImportDecision(userId, importKind, rawName) {
  const key = String(rawName || '').toLowerCase().trim();
  if (!key) return;
  db.prepare('DELETE FROM import_decisions WHERE user_id = ? AND import_kind = ? AND raw_name_lc = ?').run(userId, importKind, key);
}


function serialiseImportDecision(userId, row) {
  let appIds = [];
  try { appIds = JSON.parse(row.app_ids_json || '[]'); } catch { appIds = []; }
  const games = getLibraryGamesByIds(userId, appIds);
  return {
    import_kind: row.import_kind,
    raw_name: row.raw_name_lc,
    raw_name_lc: row.raw_name_lc,
    action: row.action,
    app_ids: appIds,
    games,
    custom_name: row.custom_name || null,
    saved_at: row.saved_at
  };
}

app.get('/api/users/:id/import-decisions', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`SELECT import_kind, raw_name_lc, action, app_ids_json, custom_name, saved_at
    FROM import_decisions WHERE user_id = ? ORDER BY saved_at DESC, import_kind, raw_name_lc`).all(userId);
  res.json({ ok: true, decisions: rows.map(r => serialiseImportDecision(userId, r)) });
});

app.patch('/api/users/:id/import-decisions', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { import_kind, raw_name, action, app_ids, custom_name } = req.body || {};
  const kind = String(import_kind || '').trim();
  const raw = String(raw_name || '').trim();
  const act = String(action || '').trim();
  if (!['purchase', 'license'].includes(kind)) return res.status(400).json({ error: 'Invalid import kind' });
  if (!raw) return res.status(400).json({ error: 'Raw import name required' });
  if (!['match', 'bundle', 'ignore', 'pending'].includes(act)) return res.status(400).json({ error: 'Invalid action' });
  if (act === 'ignore' && kind !== 'license') return res.status(400).json({ error: 'Only licence rows can be marked no match needed' });
  if (act === 'pending' && kind !== 'purchase') return res.status(400).json({ error: 'Only purchase rows can be saved as pending' });
  const ids = Array.isArray(app_ids) ? app_ids.map(Number).filter(Boolean) : [];
  if ((act === 'match' || act === 'bundle') && !ids.length) return res.status(400).json({ error: 'Choose at least one game' });
  if (act === 'match' && ids.length !== 1) return res.status(400).json({ error: 'Single match requires exactly one game' });

  db.transaction(() => {
    saveImportDecision(userId, kind, raw, act, ids, custom_name || null);
    const lc = raw.toLowerCase().trim();
    const forgetStmt = db.prepare('DELETE FROM match_overrides WHERE user_id = ? AND raw_name_lc = ?');
    if (act === 'match' && ids.length === 1) {
      db.prepare(`INSERT INTO match_overrides (user_id, raw_name_lc, app_id, learned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, raw_name_lc) DO UPDATE SET app_id=excluded.app_id, learned_at=excluded.learned_at`)
        .run(userId, lc, ids[0], Date.now());
    } else {
      forgetStmt.run(userId, lc);
    }
  })();
  res.json({ ok: true });
});

app.delete('/api/users/:id/import-decisions', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { import_kind, raw_name } = req.body || {};
  const kind = String(import_kind || '').trim();
  const raw = String(raw_name || '').trim();
  if (!['purchase', 'license'].includes(kind)) return res.status(400).json({ error: 'Invalid import kind' });
  if (!raw) return res.status(400).json({ error: 'Raw import name required' });
  db.transaction(() => {
    forgetImportDecision(userId, kind, raw);
    db.prepare('DELETE FROM match_overrides WHERE user_id = ? AND raw_name_lc = ?').run(userId, raw.toLowerCase().trim());
  })();
  res.json({ ok: true });
});

function parseSteamLicenses(text) {
  const methods = ['Gift/Guest Pass', 'Steam Store', 'Retail', 'Complimentary'];
  const dateRe = /^\s*\d{1,2}\s+\w+,?\s+\d{4}\s+/;
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^DATE\s+ITEM\s+ACQUISITION METHOD/i.test(line)) continue;
    const method = methods.find(m => line.toLowerCase().endsWith(m.toLowerCase()));
    if (!method) continue;
    const withoutMethod = line.slice(0, line.length - method.length).trim();
    const dateMatch = withoutMethod.match(/^\s*(\d{1,2}\s+\w+,?\s+\d{4})\s+(.+)$/);
    if (!dateMatch) continue;
    const item = dateMatch[2].replace(/^Remove(?=\S)/, '').trim();
    if (!item) continue;
    rows.push({ date: dateMatch[1], item, acquisition_method: method });
  }
  return rows;
}

function cleanLicenseItemForMatching(item) {
  return String(item || '')
    // Steam often appends this to free promotional packages, but the real library
    // title is just the game name, e.g. "ARK: Survival Evolved Limited Free Promotional Package - Jun 2022".
    .replace(/\s+Limited Free Promotional Package\s*-\s*.+$/i, '')
    .replace(/\s+Free Promotional Package\s*-\s*.+$/i, '')
    // Store-signup/playtest labels are licence metadata, not usually part of the library title.
    .replace(/\s+for store signup.*$/i, '')
    .replace(/\s+for playtesters.*$/i, '')
    .replace(/\s+-\s*Beta Testing.*$/i, '')
    .trim();
}

function matchLicenseRowsAgainstLibrary(userId, licenseRows) {
  const freeMethods = new Set(['Gift/Guest Pass', 'Complimentary']);
  const freeMap = new Map();
  const metadataByKey = new Map();

  for (const row of licenseRows) {
    if (!freeMethods.has(row.acquisition_method)) continue;
    const matchName = cleanLicenseItemForMatching(row.item);
    const key = normKey(matchName);
    if (!key) continue;
    if (!freeMap.has(key)) {
      freeMap.set(key, { name: matchName, total: 0.01, count: 1, multiBundle: false, refunded: false, gifts: [] });
      metadataByKey.set(key, { raw_name: row.item, acquisition_method: row.acquisition_method, match_name: matchName });
    }
  }

  return matchAgainstLibrary(userId, freeMap).map(r => {
    const meta = metadataByKey.get(normKey(r.raw_name)) || {};
    return {
      raw_name: meta.raw_name || r.raw_name,
      match_name: meta.match_name || r.raw_name,
      match: r.match,
      needs_manual_match: !r.match,
      skip: false,
      acquisition_method: meta.acquisition_method || 'Complimentary'
    };
  });
}

app.post('/api/users/:id/parse-licenses', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { raw_text } = req.body || {};
  if (!raw_text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const licenses = parseSteamLicenses(raw_text);
    let rows = matchLicenseRowsAgainstLibrary(userId, licenses);
    rows = applySavedImportDecisions(userId, 'license', rows);
    res.json({
      ok: true,
      rows,
      stats: {
        total_rows: licenses.length,
        gifted: rows.filter(r => r.acquisition_method === 'Gift/Guest Pass').length,
        complimentary: rows.filter(r => r.acquisition_method === 'Complimentary').length,
        free_rows: rows.length,
        matched: rows.filter(r => !r.skip && (r.match || r.override_app_id || (r.bundle_app_ids && r.bundle_app_ids.length))).length,
        unmatched: rows.filter(r => !r.skip && !(r.match || r.override_app_id || (r.bundle_app_ids && r.bundle_app_ids.length))).length
      }
    });
  } catch (err) {
    logger.error('License parse failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/import-licenses', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { rows } = req.body || {};
  // steam_account_id is accepted for consistency with import-history. Licence import
  // marks existing games as free, which is keyed on (user_id, app_id) and naturally
  // covers all of the user's linked accounts, so no per-account scoping needed.
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

  let gifted = 0, complimentary = 0, skipped = 0, unmatched = 0;
  db.transaction(() => {
    const markFreeLicense = db.prepare(`UPDATE user_games
      SET paid_price_cents = 0,
          play_status = 'free',
          price_is_estimated = 0,
          price_estimate_source = ?
      WHERE user_id = ? AND app_id = ?`);
    const existingGameStmt = db.prepare('SELECT paid_price_cents, price_estimate_source FROM user_games WHERE user_id = ? AND app_id = ?');
    const learnStmt = db.prepare(`INSERT INTO match_overrides (user_id, raw_name_lc, app_id, learned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, raw_name_lc) DO UPDATE SET app_id=excluded.app_id, learned_at=excluded.learned_at`);
    const forgetStmt = db.prepare('DELETE FROM match_overrides WHERE user_id = ? AND raw_name_lc = ?');

    for (const row of rows) {
      if (row.skip) {
        if (row.raw_name) {
          forgetStmt.run(userId, String(row.raw_name).toLowerCase().trim());
          saveImportDecision(userId, 'license', row.raw_name, 'ignore', []);
        }
        skipped++;
        continue;
      }
      const method = row.acquisition_method === 'Complimentary' ? 'Complimentary' : 'Gift/Guest Pass';
      const source = `Steam license import: ${method}`;
      const appIds = Array.isArray(row.bundle_app_ids) && row.bundle_app_ids.length
        ? row.bundle_app_ids
        : [row.app_id || row.match?.app_id].filter(Boolean);

      if (!appIds.length) { unmatched++; continue; }

      let changedThisRow = 0;
      for (const appId of appIds) {
        const existing = existingGameStmt.get(userId, appId);
        // Purchase evidence outranks a complimentary/free-promo licence.
        // This stops re-importing licences from moving a game back to Free after
        // the purchase-history import has proved money was spent on it.
        if (method === 'Complimentary' && existing && Number(existing.paid_price_cents || 0) > 0) {
          skipped++;
          continue;
        }
        const info = markFreeLicense.run(source, userId, appId);
        if (info.changes > 0) {
          changedThisRow++;
          if (method === 'Gift/Guest Pass') gifted++;
          else complimentary++;
        } else skipped++;
      }

      // Remember review decisions for the next re-import.
      if (row.raw_name && appIds.length === 1) {
        learnStmt.run(userId, String(row.raw_name).toLowerCase().trim(), appIds[0], Date.now());
        saveImportDecision(userId, 'license', row.raw_name, 'match', appIds);
      } else if (row.raw_name && appIds.length > 1) {
        saveImportDecision(userId, 'license', row.raw_name, 'bundle', appIds);
      } else if (row.raw_name) {
        forgetImportDecision(userId, 'license', row.raw_name);
      }
    }
  })();

  logger.info('License import complete', { user_id: userId, gifted, complimentary, skipped, unmatched });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'license_import');
  res.json({ ok: true, gifted, complimentary, free: gifted + complimentary, skipped, unmatched });
});

app.post('/api/users/:id/parse-history', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { raw_text } = req.body || {};
  if (!raw_text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const transactions = parsePurchaseHistory(raw_text);
    const { map, stats } = aggregatePurchases(transactions);
    let rows = matchAgainstLibrary(userId, map);
    rows = applySavedImportDecisions(userId, 'purchase', rows);
    logger.info('Parse complete', { user_id: userId, transactions: transactions.length,
      purchases: stats.purchases, total_spent: stats.totalSpent.toFixed(2),
      matched: rows.filter(r => !r.skip && r.match).length,
      unmatched: rows.filter(r => !r.skip && !r.match).length });
    res.json({ ok: true, rows, stats });
  }
  catch (err) { logger.error('Parse failed', { error: err.message, stack: err.stack }); res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/library-search', requireSetup, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const uid = req.params.id;
  const rows = q.length < 2
    ? db.prepare('SELECT DISTINCT g.app_id, g.name FROM games g JOIN user_games ug ON ug.app_id = g.app_id WHERE ug.user_id = ? ORDER BY ug.playtime_minutes DESC LIMIT 50').all(uid)
    : db.prepare('SELECT DISTINCT g.app_id, g.name FROM games g JOIN user_games ug ON ug.app_id = g.app_id WHERE ug.user_id = ? AND LOWER(g.name) LIKE ? ORDER BY g.name COLLATE NOCASE LIMIT 30').all(uid, `%${q}%`);
  res.json({ games: rows });
});

app.post('/api/users/:id/import-history', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { rows, steam_account_id } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

  // Resolve which Steam account this import is for. If not specified, fall back to the user's primary (oldest) account.
  let targetAccountId = steam_account_id ? parseInt(steam_account_id) : null;
  if (targetAccountId) {
    const valid = db.prepare('SELECT id FROM user_steam_accounts WHERE id = ? AND user_id = ?').get(targetAccountId, userId);
    if (!valid) targetAccountId = null;
  }
  if (!targetAccountId) {
    const primary = db.prepare('SELECT id FROM user_steam_accounts WHERE user_id = ? ORDER BY added_at ASC LIMIT 1').get(userId);
    targetAccountId = primary?.id || null;
  }

  // Expand bundle rows: if row.bundle_app_ids is set, create one entry per app_id with split price
  const expanded = [];
  for (const row of rows) {
    if (row.skip) { expanded.push(row); continue; }
    if (Array.isArray(row.bundle_app_ids) && row.bundle_app_ids.length > 0) {
      const splitCents = Math.round(row.paid_cents / row.bundle_app_ids.length);
      for (const appId of row.bundle_app_ids) {
        expanded.push({ skip: false, app_id: appId, paid_cents: splitCents, raw_name: row.raw_name });
      }
    } else {
      expanded.push(row);
    }
  }

  // Pre-pass: SUM all prices targeting the same app_id within this batch.
  // This handles the ETS2 base + 5 DLC case: all become one total per app_id.
  const totals = new Map(); // app_id → total_cents
  for (const row of expanded) {
    if (row.skip || !row.app_id) continue;
    totals.set(row.app_id, (totals.get(row.app_id) || 0) + row.paid_cents);
  }

  let saved = 0, dlc_linked = 0, pending = 0, skipped = 0, preserved = 0;
  const getImportedGame = db.prepare(`SELECT paid_price_cents FROM user_games
    WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`);
  const updateImportedGame = db.prepare(`UPDATE user_games
    SET paid_price_cents = ?,
        price_is_estimated = 0,
        price_estimate_source = NULL,
        play_status = CASE WHEN play_status = 'free' AND ? > 0 THEN 'unplayed' ELSE play_status END
    WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`);
  const insertImportedGame = db.prepare(`INSERT INTO user_games
    (user_id, app_id, paid_price_cents, price_is_estimated, price_estimate_source, play_status, steam_account_id)
    VALUES (?,?,?,?,NULL,?,?)`);
  db.transaction(() => {
    // Write each unique app_id ONCE with the summed total
    // Re-import safety: take MAX of (current stored price) and (newly imported total)
    // so reimporting doesn't double-count, manual edits aren't lost, but new purchases bump up
    for (const [appId, total] of totals.entries()) {
      const existing = getImportedGame.get(userId, appId, accountKey(targetAccountId));
      if (existing) {
        const currentVal = existing.paid_price_cents || 0;
        const winner = Math.max(currentVal, total);
        if (winner !== currentVal) {
          updateImportedGame.run(winner, winner, userId, appId, accountKey(targetAccountId));
          saved++;
        } else {
          preserved++;
        }
      } else {
        insertImportedGame.run(userId, appId, total, 0, total > 0 ? 'unplayed' : null, targetAccountId);
        saved++;
      }
    }
    // Count DLC-style linked rows (more than one row hit the same app_id)
    const writeCounts = new Map();
    for (const row of expanded) {
      if (row.skip || !row.app_id) continue;
      writeCounts.set(row.app_id, (writeCounts.get(row.app_id) || 0) + 1);
    }
    for (const [, c] of writeCounts) if (c > 1) dlc_linked += (c - 1);

    // Pending rows (no app_id)
    for (const row of expanded) {
      if (row.skip) { skipped++; continue; }
      if (row.app_id) continue;
      const name = row.custom_name || row.raw_name;
      db.prepare('INSERT INTO pending_prices (user_id, game_name_raw, paid_price_cents, imported_at) VALUES (?,?,?,?)')
        .run(userId, name, row.paid_cents, Date.now());
      pending++;
    }

    // Learn match overrides: any row with a raw_name + app_id pairing is a future shortcut.
    // We store the RECEIPT name (lowercased) → app_id so the next import auto-resolves it.
    const learnStmt = db.prepare(`INSERT INTO match_overrides (user_id, raw_name_lc, app_id, learned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, raw_name_lc) DO UPDATE SET app_id=excluded.app_id, learned_at=excluded.learned_at`);
    for (const row of expanded) {
      if (row.skip || !row.app_id || !row.raw_name) continue;
      const lc = String(row.raw_name).toLowerCase().trim();
      if (!lc) continue;
      learnStmt.run(userId, lc, row.app_id, Date.now());
    }

    // Remember the review decisions for the next re-import.
    for (const row of rows) {
      if (!row.raw_name) continue;
      if (row.skip) continue;
      if (Array.isArray(row.bundle_app_ids) && row.bundle_app_ids.length) {
        saveImportDecision(userId, 'purchase', row.raw_name, 'bundle', row.bundle_app_ids);
      } else if (row.app_id) {
        saveImportDecision(userId, 'purchase', row.raw_name, 'match', [row.app_id]);
      } else {
        saveImportDecision(userId, 'purchase', row.raw_name, 'pending', [], row.custom_name || row.raw_name);
      }
    }
  })();
  logger.info('Import complete', { user_id: userId, unique_games: saved, dlc_linked, pending, skipped, preserved });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'import');
  res.json({ ok: true, saved, dlc_linked, pending, skipped, preserved });
});

// Custom games — for titles not on Steam (DRM-free, board games tracked here, etc.)
// Uses negative app_ids to avoid collision with Steam's positive IDs.
app.post('/api/users/:id/custom-game', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const { name, paid_price_cents, playtime_minutes, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (paid_price_cents !== undefined && paid_price_cents !== null && (paid_price_cents < 0 || !Number.isFinite(paid_price_cents))) {
    return res.status(400).json({ error: 'Invalid price' });
  }
  if (playtime_minutes !== undefined && playtime_minutes !== null && (playtime_minutes < 0 || !Number.isFinite(playtime_minutes))) {
    return res.status(400).json({ error: 'Invalid playtime' });
  }

  // Pick next available negative app_id
  const minRow = db.prepare('SELECT MIN(app_id) AS min_id FROM games').get();
  const nextId = Math.min(-1, (minRow.min_id || 0) - 1);

  db.transaction(() => {
    db.prepare('INSERT INTO games (app_id, name) VALUES (?, ?)').run(nextId, String(name).trim());
    db.prepare(`INSERT INTO user_games (user_id, app_id, paid_price_cents, playtime_minutes, notes, manual_override)
      VALUES (?, ?, ?, ?, ?, 1)`).run(userId, nextId,
        paid_price_cents || 0,
        Math.round(playtime_minutes || 0),
        notes || null);
  })();

  logger.info('Custom game added', { user_id: userId, app_id: nextId, name });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'custom_game');
  res.json({ ok: true, app_id: nextId });
});

// Delete a custom game (also any user-added title with negative app_id)
app.delete('/api/users/:id/custom-game/:appId', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const appId = parseInt(req.params.appId);
  if (appId >= 0) return res.status(400).json({ error: 'Only custom games (negative app_id) can be deleted' });
  db.transaction(() => {
    db.prepare('DELETE FROM user_games WHERE user_id = ? AND app_id = ?').run(userId, appId);
    const stillUsed = db.prepare('SELECT 1 FROM user_games WHERE app_id = ? LIMIT 1').get(appId);
    if (!stillUsed) db.prepare('DELETE FROM games WHERE app_id = ?').run(appId);
  })();
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'custom_game_delete');
  res.json({ ok: true });
});

// Price estimation: uses IsThereAnyDeal API for historical lows (preferred),
// falls back to Steam appdetails for current price.
// ITAD requires a free API key from https://isthereanydeal.com/apps/my/

async function estimatePricesForUser(userId, reEstimate = false) {
  // If reEstimate is true, also re-price games that were previously estimated
  // (so switching from Steam fallback to ITAD updates them)
  let candidates;
  if (reEstimate) {
    candidates = db.prepare(`SELECT ug.app_id FROM user_games ug
      WHERE ug.user_id = ? AND ug.app_id > 0
        AND (ug.play_status IS NULL OR ug.play_status NOT IN ('exempt', 'free', 'completed'))
        AND (ug.paid_price_cents IS NULL OR ug.paid_price_cents = 0 OR ug.price_is_estimated = 1)`).all(userId);
  } else {
    candidates = db.prepare(`SELECT ug.app_id FROM user_games ug
      WHERE ug.user_id = ? AND (ug.paid_price_cents IS NULL OR ug.paid_price_cents = 0)
        AND ug.app_id > 0
        AND (ug.play_status IS NULL OR ug.play_status NOT IN ('exempt', 'free', 'completed'))`).all(userId);
  }
  if (!candidates.length) return { updated: 0, marked_free: 0, failed: 0, total: 0 };

  const itadKey = getConfig('itad_api_key');
  let updated = 0, markedFree = 0, failed = 0;
  const handledAppIds = new Set();

  if (itadKey) {
    const appIds = candidates.map(c => c.app_id);
    logger.info("ITAD estimation starting", { key_prefix: itadKey.slice(0, 6), game_count: appIds.length });
    try {
      const itadMap = new Map();
      for (const appId of appIds) {
        try {
          const lookupUrl = `https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(itadKey)}&appid=${appId}&shop=61`;
          const lookupRes = await fetch(lookupUrl);
          if (lookupRes.ok) {
            const d = await lookupRes.json();
            if (d?.found && d?.game?.id) {
              itadMap.set(appId, d.game.id);
            }
          } else if (itadMap.size === 0) {
            const errText = await lookupRes.text().catch(() => "");
            logger.warn("ITAD lookup failed for first game", { appId, status: lookupRes.status, body: errText.slice(0, 200) });
          }
        } catch (err) {
          if (itadMap.size === 0) logger.warn("ITAD lookup error", { appId, error: err.message });
        }
        await new Promise(r => setTimeout(r, 200));
      }
      logger.info("ITAD lookup complete", { found: itadMap.size, total: appIds.length });

      // Step 2: Get historical lows in batches of 200 using /games/historylow/v1
      const itadIds = [...itadMap.values()];
      const reverseMap = new Map(); // itad id → steam app_id
      for (const [appId, itadId] of itadMap) reverseMap.set(itadId, appId);

      const histMap = new Map(); // itad id → { price_cents, shop, currency }
      for (let i = 0; i < itadIds.length; i += 200) {
        const batch = itadIds.slice(i, i + 200);
        try {
          const histRes = await fetch(
            `https://api.isthereanydeal.com/games/historylow/v1?key=${encodeURIComponent(itadKey)}&country=GB`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) }
          );
          if (histRes.ok) {
            const histData = await histRes.json();
            // Response should be an array of { id, low: { shop: {...}, price: { amount, amountInt, currency }, ... } }
            if (Array.isArray(histData)) {
              for (const entry of histData) {
                if (entry?.low?.price) {
                  const p = entry.low.price;
                  // amountInt is in smallest currency unit (pence for GBP)
                  const cents = p.amountInt || Math.round((p.amount || 0) * 100);
                  const shop = entry.low.shop?.name || 'Unknown';
                  histMap.set(entry.id, { cents, shop, currency: p.currency || 'GBP' });
                }
              }
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }

      // Step 3: Apply historical lows
      for (const [appId, itadId] of itadMap) {
        const hist = histMap.get(itadId);
        if (hist && hist.cents > 0) {
          const source = `Historical low: £${(hist.cents / 100).toFixed(2)} at ${hist.shop} (via IsThereAnyDeal)`;
          if (updateCanonicalPrice(userId, appId, hist.cents, true, source) > 0) updated++;
          handledAppIds.add(appId);
        }
      }
    } catch (err) {
      logger.error('ITAD price estimation failed, falling back to Steam', { error: err.message });
    }
  }

  // --- Steam fallback for anything ITAD didn't cover ---
  const remainingCandidates = candidates.filter(c => !handledAppIds.has(c.app_id));
  for (const row of remainingCandidates) {
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${row.app_id}&cc=gb`;
      const res = await fetch(url);
      if (!res.ok) { failed++; continue; }
      const data = await res.json();
      const entry = data[String(row.app_id)];
      if (!entry?.success || !entry?.data) { failed++; continue; }
      if (entry.data.is_free) {
        const existing = getCanonicalUserGame(userId, row.app_id, getPrimarySteamAccountId(userId));
        if (existing) {
          db.transaction(() => {
            db.prepare(`UPDATE user_games SET play_status = 'free'
              WHERE user_id = ? AND app_id = ? AND COALESCE(steam_account_id, 0) = ?`)
              .run(userId, row.app_id, accountKey(existing.steam_account_id));
            clearDuplicateLedgerFields(userId, row.app_id, existing.steam_account_id, { status: true });
          })();
          markedFree++;
        }
        continue;
      }
      const po = entry.data.price_overview;
      if (po) {
        const cents = po.final ?? po.initial;
        if (cents && cents > 0) {
          const source = `Current Steam store price: £${(cents / 100).toFixed(2)}`;
          if (updateCanonicalPrice(userId, row.app_id, cents, true, source) > 0) updated++;
          continue;
        }
      }
      failed++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 500));
  }

  return { updated, marked_free: markedFree, failed, total: candidates.length };
}

app.post('/api/users/:id/estimate-prices', requireSetup, async (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  const reEstimate = !!(req.body?.re_estimate);
  try {
    const result = await estimatePricesForUser(userId, reEstimate);
    logger.info('Price estimation complete', { user_id: userId, re_estimate: reEstimate, ...result });
    if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'estimate_prices');
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('Price estimation failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/users/:id/resolve-pending', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const { pending_id, app_id } = req.body || {};
  if (!pending_id || !app_id) return res.status(400).json({ error: 'pending_id and app_id required' });
  const pending = db.prepare('SELECT * FROM pending_prices WHERE id = ? AND user_id = ?').get(pending_id, userId);
  if (!pending) return res.status(404).json({ error: 'Pending entry not found' });
  const exists = getCanonicalUserGame(userId, app_id, getPrimarySteamAccountId(userId));
  if (exists) updateCanonicalPrice(userId, app_id, pending.paid_price_cents, false, null);
  else db.prepare('INSERT INTO user_games (user_id, app_id, paid_price_cents) VALUES (?,?,?)').run(userId, app_id, pending.paid_price_cents);
  db.prepare('DELETE FROM pending_prices WHERE id = ?').run(pending_id);
  logger.info('Pending resolved', { user_id: userId, app_id, pending_id });
  res.json({ ok: true });
});

app.get('/api/users/:id/pending-prices', requireSetup, (req, res) => {
  res.json({ pending: db.prepare('SELECT * FROM pending_prices WHERE user_id = ? ORDER BY imported_at DESC').all(req.params.id) });
});

// ---------- Admin/debug ----------
function requireAdmin(req, res, next) {
  if (!verifyPassword(req.headers['x-admin-password'])) return res.status(401).json({ error: 'Admin password required' });
  next();
}
app.post('/api/admin/verify', (req, res) => res.json({ ok: verifyPassword(req.body?.password) }));
app.get('/api/debug/info', requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  const gotw = getCurrentGotWPicks();
  const mergeRows = db.prepare(`SELECT mg.id, mg.user_id, u.display_name, mg.primary_app_id, pg.name AS primary_name,
      GROUP_CONCAT(gm.app_id || ':' || COALESCE(g.name, 'Unknown'), ' | ') AS games
    FROM game_merge_groups mg
    JOIN users u ON u.id = mg.user_id
    JOIN game_merge_members gm ON gm.group_id = mg.id
    LEFT JOIN games g ON g.app_id = gm.app_id
    LEFT JOIN games pg ON pg.app_id = mg.primary_app_id
    GROUP BY mg.id
    ORDER BY u.display_name COLLATE NOCASE, mg.created_at`).all();
  res.json({ version:VERSION, node_version:process.version, uptime_seconds:Math.floor(process.uptime()),
    memory_mb:{ rss:Math.round(mem.rss/1048576), heap:Math.round(mem.heapUsed/1048576) },
    db_stats:{
      users:db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      games:db.prepare('SELECT COUNT(*) AS c FROM games').get().c,
      user_games:db.prepare('SELECT COUNT(*) AS c FROM user_games').get().c,
      sync_log:db.prepare('SELECT COUNT(*) AS c FROM sync_log').get().c,
      merge_groups:db.prepare('SELECT COUNT(*) AS c FROM game_merge_groups').get().c },
    merge_groups: mergeRows.map(r => {
      const ids = String(r.games || '').split(' | ').filter(Boolean).map(x => Number(x.split(':')[0]));
      const personal = gotw?.personal_picks?.[r.user_id] ?? gotw?.personal_picks?.[String(r.user_id)];
      return {
        player: r.display_name,
        player_id: r.user_id,
        merge_group_id: r.id,
        primary_game: { app_id: r.primary_app_id, name: r.primary_name },
        merged_games: String(r.games || '').split(' | ').filter(Boolean),
        contains_double_xp_game: ids.includes(Number(gotw?.group_app_id)) || ids.includes(Number(personal)),
      };
    }),
    setup_complete:isSetupComplete(), log_files:fs.readdirSync(LOGS_DIR).sort() });
});
app.get('/api/admin/steam-metadata', requireAdmin, (req, res) => {
  const pause = getSteamMetadataPause();
  const rows = db.prepare(`SELECT g.app_id, g.name, g.steam_metadata_last_synced_at
    FROM games g
    WHERE g.app_id > 0
      AND (g.steam_metadata_last_synced_at IS NULL OR g.genres_json IS NULL OR g.categories_json IS NULL)
    ORDER BY g.name COLLATE NOCASE
    LIMIT 200`).all();
  const totals = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN app_id > 0 AND steam_metadata_last_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced,
      SUM(CASE WHEN app_id > 0 AND (steam_metadata_last_synced_at IS NULL OR genres_json IS NULL OR categories_json IS NULL) THEN 1 ELSE 0 END) AS missing
    FROM games WHERE app_id > 0`).get();
  res.json({ ok: true, totals, missing: rows.map(r => ({
    app_id: r.app_id,
    name: r.name,
    steamMetadataLastSyncedAt: r.steam_metadata_last_synced_at ? new Date(r.steam_metadata_last_synced_at).toISOString() : null,
  })), paused: !!pause, pause });
});
app.post('/api/admin/steam-metadata/refresh', requireAdmin, async (req, res) => {
  try {
    const pause = getSteamMetadataPause();
    if (pause && !req.body?.ignore_pause) {
      return res.status(409).json({ ok: false, paused: true, pause, error: 'Steam metadata refresh is paused. Resume it before refreshing again.' });
    }
    const appId = req.body?.app_id == null ? null : Number(req.body.app_id);
    const ids = appId
      ? [appId]
      : db.prepare('SELECT app_id FROM games WHERE app_id > 0 ORDER BY name COLLATE NOCASE').all().map(r => r.app_id);
    if (appId && !Number.isInteger(appId)) return res.status(400).json({ ok: false, error: 'Valid app_id required' });
    const result = await refreshSteamMetadataForAppIds(ids, { force: true });
    logger.info('Manual Steam metadata refresh complete', { app_id: appId, ...result });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('Manual Steam metadata refresh failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/admin/steam-metadata/resume', requireAdmin, (req, res) => {
  resumeSteamMetadata();
  logger.info('Steam metadata refresh resumed by admin');
  res.json({ ok: true, paused: false });
});

// Public status endpoint for the help-button indicator.
app.get('/api/steam-metadata/status', (req, res) => {
  const pause = getSteamMetadataPause();
  const queued = steamMetadataQueue.size;
  let status = steamMetadataState.status;
  if (pause) status = 'paused';
  else if (status === 'idle' && queued > 0) status = 'running';
  res.json({
    status,
    total: steamMetadataState.total,
    checked: steamMetadataState.checked,
    updated: steamMetadataState.updated,
    failed: steamMetadataState.failed,
    rate_limited: steamMetadataState.rate_limited,
    queued,
    started_at: steamMetadataState.started_at,
    finished_at: steamMetadataState.finished_at,
    pause: pause || steamMetadataState.pause || null,
  });
});
app.get('/api/debug/logs', requireAdmin, (req, res) => {
  const file = path.join(LOGS_DIR, `app-${todayStamp()}.log`);
  if (!fs.existsSync(file)) return res.json({ lines: [] });
  res.json({ lines: fs.readFileSync(file,'utf8').trim().split('\n').slice(-(parseInt(req.query.lines)||50)) });
});
app.get('/api/debug/errors', requireAdmin, (req, res) => {
  const file = path.join(LOGS_DIR, `errors-${todayStamp()}.log`);
  if (!fs.existsSync(file)) return res.json({ lines: [] });
  res.json({ lines: fs.readFileSync(file,'utf8').trim().split('\n').slice(-50) });
});

// ---------- Guards + static ----------
// First-run guard (two phases):
//   Part 1 — setup_completed_at NOT set:
//     every page request goes to /setup, except /setup itself and /api/setup/*.
//   Part 2 — setup_completed_at set but ZERO users exist:
//     every page request goes to /first-profile, except /first-profile itself,
//     /api/users (for creation), and shared static assets.
//   Steady state — setup done + at least one user:
//     normal app, "/" serves profiles.html.
const SETUP_PATHS = new Set(['/setup', '/setup.html']);
const FIRST_PROFILE_PATHS = new Set(['/first-profile', '/first-profile.html']);
const ALWAYS_ALLOWED_PREFIXES = ['/api/setup/', '/health', '/style.css', '/js/', '/favicon'];
// Endpoints Part 2 actually needs in order to create the first user.
const PART2_ALLOWED_PREFIXES = ['/api/users', '/api/group', '/api/setup/'];
function isStaticAsset(p) {
  return /\.(css|js|png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|map)$/i.test(p);
}
function userCount() {
  try { return db.prepare('SELECT COUNT(*) AS c FROM users').get().c; }
  catch { return 0; }
}
app.use((req, res, next) => {
  const p = req.path;
  if (!isSetupComplete()) {
    if (SETUP_PATHS.has(p)) return res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
    if (p === '/') return res.redirect(302, '/setup');
    if (ALWAYS_ALLOWED_PREFIXES.some(pref => p.startsWith(pref))) return next();
    if (isStaticAsset(p)) return next();
    if (req.accepts(['html', 'json']) === 'html') return res.redirect(302, '/setup');
    return res.status(403).json({ error: 'Setup not complete', redirect: '/setup' });
  }
  // Setup is complete — Part 2 still required while no users exist.
  if (userCount() === 0) {
    if (FIRST_PROFILE_PATHS.has(p)) return res.sendFile(path.join(PUBLIC_DIR, 'first-profile.html'));
    if (SETUP_PATHS.has(p)) return res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
    if (p === '/') return res.redirect(302, '/first-profile');
    if (PART2_ALLOWED_PREFIXES.some(pref => p.startsWith(pref))) return next();
    if (ALWAYS_ALLOWED_PREFIXES.some(pref => p.startsWith(pref))) return next();
    if (isStaticAsset(p)) return next();
    if (req.accepts(['html', 'json']) === 'html') return res.redirect(302, '/first-profile');
    return res.status(403).json({ error: 'First profile not yet created', redirect: '/first-profile' });
  }
  if (p === '/') return res.sendFile(path.join(PUBLIC_DIR, 'profiles.html'));
  if (SETUP_PATHS.has(p)) return res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
  if (FIRST_PROFILE_PATHS.has(p)) return res.sendFile(path.join(PUBLIC_DIR, 'first-profile.html'));
  next();
});
app.use(express.static(PUBLIC_DIR));

// ---------- PHASE 4: Scheduled weekly sync (Wed 6:30pm GMT) ----------
// Cron: minute=30, hour=18, day-of-week=3 (Wednesday)
cron.schedule('30 18 * * 3', async () => {
  logger.info('Scheduled weekly sync starting (Wed 6:30pm GMT)');
  const users = db.prepare('SELECT id, display_name FROM users WHERE steam_id IS NOT NULL').all();
  let okCount = 0, errCount = 0;
  for (const u of users) {
    try {
      const result = await syncUserLibrary(u.id);
      if (result.ok) okCount++; else errCount++;
    } catch (err) {
      errCount++;
      logger.error('Scheduled sync failed for user', { user_id: u.id, error: err.message });
    }
    // Small delay between users to be polite to Steam API
    await new Promise(r => setTimeout(r, 1500));
  }
  logger.info('Scheduled weekly sync complete', { ok: okCount, errors: errCount, total: users.length });
}, { timezone: 'Etc/UTC' });
logger.info('Scheduled weekly sync registered: Wednesdays at 18:30 UTC (GMT)');

// ---------- PHASE 7: Socket.io for real-time leaderboard updates ----------
const httpServer = http.createServer(app);
const { Server: SocketServer } = require('socket.io');
const io = new SocketServer(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  logger.debug('Socket connected', { id: socket.id });
  socket.on('disconnect', () => logger.debug('Socket disconnected', { id: socket.id }));
});

// Broadcast helper — called when user data changes
function broadcastLeaderboardUpdate(userId, reason) {
  io.emit('leaderboard:update', { user_id: userId, reason, at: Date.now() });
}

// Expose to other parts of server (PATCH endpoint, sync, import all trigger this)
app.locals.broadcastLeaderboardUpdate = broadcastLeaderboardUpdate;

// ---------- Leaderboard endpoint ----------
// Reusable: calculate the same leaderboard data shape we serve to the UI.
// =====================================================================
// XP SYSTEM
// =====================================================================
// Rules:
//   - Baseline = playtime at the moment XP tracking started (set on first sync)
//   - Hours played since baseline earn XP if the game was a contract (not free/exempt)
//     and the hours were spent while still under the paid threshold
//   - Games of the Week (group + personal) earn Double XP for hours played on them
// XP is computed on-demand from current state — never stored as a counter.

function getCurrentGotWPicks() {
  // Returns the most recent picks row, or null
  const row = db.prepare('SELECT group_app_id, personal_picks_json FROM games_of_week ORDER BY week_start_at DESC LIMIT 1').get();
  if (!row) return null;
  let personal = {};
  try { personal = JSON.parse(row.personal_picks_json || '{}'); } catch {}
  return { group_app_id: row.group_app_id, personal_picks: personal };
}

function roundXp(n) { return Math.round((n || 0) * 10) / 10; }

function computeUserXpReceipt(userId, gotwPicks) {
  const baselines = db.prepare('SELECT app_id, baseline_minutes, baseline_at FROM xp_baseline WHERE user_id = ?').all(userId);
  const baselineMap = new Map();
  for (const b of baselines) baselineMap.set(b.app_id, b);

  const rows = getEffectiveLedgerEntriesForPlayer(userId, { gotwPicks });

  let totalXp = 0;
  let gotwBonus = 0;
  let contractXp = 0;
  const entries = [];
  const personalApp = (gotwPicks?.personal_picks?.[userId] ?? gotwPicks?.personal_picks?.[String(userId)]) || null;
  const groupApp = gotwPicks?.group_app_id || null;

  for (const r of rows) {
    const memberIds = r.is_merged ? r.merged_app_ids : [r.app_id];
    const baselineRows = memberIds.map(id => baselineMap.get(id)).filter(Boolean);
    if (!baselineRows.length) continue; // no baseline yet — game added since baseline creation
    let baseline = 0;
    let baselineAt = null;
    for (const appId of memberIds) {
      const b = baselineMap.get(appId);
      if (b) {
        baseline += b.baseline_minutes || 0;
        baselineAt = Math.max(baselineAt || 0, b.baseline_at || 0);
      } else if (r.is_merged) {
        const member = r.merged_games?.find(g => Number(g.app_id) === Number(appId));
        baseline += member?.playtime_minutes || 0;
      }
    }
    const currentMinutes = r.playtime_minutes || 0;
    const delta = currentMinutes - baseline;
    if (delta <= 0) continue;
    if (r.play_status === 'exempt' || r.play_status === 'free') continue;
    const price = (r.paid_price_cents || 0) / 100;
    if (price === 0) continue; // no contract = no XP

    // Of the delta minutes, only those played while the contract was still unpaid count.
    // Paid threshold in minutes = price * 60 (since 1h = £1)
    const thresholdMinutes = price * 60;
    if (baseline >= thresholdMinutes) continue; // already paid off when baseline was set
    const minutesUnderThreshold = Math.min(delta, thresholdMinutes - baseline);
    if (minutesUnderThreshold <= 0) continue;
    const baseXp = minutesUnderThreshold / 60; // 1 XP per hour

    let bonusType = null;
    if (memberIds.some(id => qualifiesForDoubleXp(userId, id, groupApp))) bonusType = 'Group Game of the Week';
    if (memberIds.some(id => qualifiesForDoubleXp(userId, id, personalApp))) bonusType = bonusType ? 'Group + Personal Game of the Week' : 'Personal Game of the Week';
    const multiplier = bonusType ? GOTW_XP_MULTIPLIER : 1.0;

    const earned = baseXp * multiplier;
    const bonus = earned - baseXp;
    totalXp += earned;
    contractXp += baseXp;
    gotwBonus += bonus;

    entries.push({
      app_id: r.app_id,
      name: r.name,
      price_pounds: roundXp(price),
      baseline_hours: roundXp(baseline / 60),
      current_hours: roundXp(currentMinutes / 60),
      counted_hours: roundXp(minutesUnderThreshold / 60),
      base_xp: roundXp(baseXp),
      bonus_xp: roundXp(bonus),
      total_xp: roundXp(earned),
      multiplier,
      bonus_type: bonusType,
      merge_group_id: r.merge_group_id || null,
      merged_app_ids: r.merged_app_ids || null,
      baseline_at: baselineAt || null,
    });
  }

  entries.sort((a, b) => b.total_xp - a.total_xp || a.name.localeCompare(b.name));
  return {
    total: roundXp(totalXp),
    from_contracts: roundXp(contractXp),
    from_gotw_bonus: roundXp(gotwBonus),
    entries,
  };
}

function computeUserXp(userId, gotwPicks) {
  const receipt = computeUserXpReceipt(userId, gotwPicks);
  return {
    total: receipt.total,
    from_contracts: receipt.from_contracts,
    from_gotw_bonus: receipt.from_gotw_bonus,
  };
}

function computeLeaderboard() {
  const users = db.prepare(`SELECT id, display_name, steam_id, avatar_url, last_synced_at FROM users ORDER BY display_name COLLATE NOCASE`).all();
  const gotwPicks = getCurrentGotWPicks();

  const result = users.map(u => {
    // Effective rows respect per-player manual merge groups.
    const rows = getEffectiveLedgerEntriesForPlayer(u.id, { gotwPicks });

    let totalSpent = 0, totalHours = 0, totalDebt = 0, hours2w = 0;
    const counts = { all: rows.length, contracts: 0, paid: 0, arrears: 0, outstanding: 0, free: 0, exempt: 0 };

    for (const r of rows) {
      const hours = (r.playtime_minutes || 0) / 60;
      const price = (r.paid_price_cents || 0) / 100;
      totalHours += hours;
      hours2w += (r.playtime_last_2weeks || 0) / 60;
      if (r.play_status === 'exempt') { counts.exempt++; continue; }
      if (price === 0) {
        // Missing/blank/zero price carries no obligation: treat as free.
        counts.free++;
        continue;
      }
      totalSpent += price;
      counts.contracts++;
      if (r.play_status === 'completed' || r.completed_at) {
        // Manual "Mark paid - complete" settles the contract regardless of hours.
        counts.paid++;
        continue;
      }
      const debt = Math.max(0, price - hours);
      totalDebt += debt;
      if (hours >= price) counts.paid++;
      else if (hours > 0) counts.arrears++;
      else counts.outstanding++;
    }

    const settlementRate = counts.contracts > 0
      ? Math.round((counts.paid / counts.contracts) * 100)
      : null;

    const xp = computeUserXp(u.id, gotwPicks);

    // Pull this user's GotW pick (the game name + their progress)
    let personalGotW = null;
    const personalAppId = gotwPicks?.personal_picks?.[u.id] ?? gotwPicks?.personal_picks?.[String(u.id)];
    if (personalAppId) {
      const aggregated = rows.find(r => r.app_id === Number(personalAppId) ||
        (Array.isArray(r.merged_app_ids) && r.merged_app_ids.map(Number).includes(Number(personalAppId))));
      const game = aggregated
        ? { ...db.prepare('SELECT app_id, name FROM games WHERE app_id = ?').get(personalAppId), ...aggregated }
        : db.prepare('SELECT app_id, name FROM games WHERE app_id = ?').get(personalAppId);
      if (game) {
        personalGotW = {
          app_id: game.app_id,
          name: game.name,
          hours: Math.round((game.playtime_minutes || 0) / 6) / 10,
          price: (game.paid_price_cents || 0) / 100,
        };
      }
    }

    return {
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      last_synced_at: u.last_synced_at,
      app_ids: rows.map(r => r.app_id),
      stats: {
        games: rows.length,
        total_spent_pounds: Math.round(totalSpent * 100) / 100,
        total_hours: Math.round(totalHours),
        hours_last_2weeks: Math.round(hours2w * 10) / 10,
        total_debt_pounds: Math.round(totalDebt * 100) / 100,
        avg_price_per_hour: totalHours > 0 ? Math.round((totalSpent / totalHours) * 100) / 100 : null,
        settlement_rate: settlementRate,
        counts,
        xp: xp.total,
        xp_contracts: xp.from_contracts,
        xp_gotw_bonus: xp.from_gotw_bonus,
      },
      personal_gotw: personalGotW,
    };
  });

  // Shared library
  const appCounts = new Map();
  for (const u of result) {
    for (const appId of u.app_ids) {
      if (!appCounts.has(appId)) appCounts.set(appId, new Set());
      appCounts.get(appId).add(u.id);
    }
  }
  let totalShared = 0, everyoneHas = 0;
  for (const [, s] of appCounts) {
    if (s.size >= 2) totalShared++;
    if (s.size === result.length && result.length >= 2) everyoneHas++;
  }

  // Group GotW details
  let groupGotW = null;
  if (gotwPicks?.group_app_id) {
    const game = db.prepare('SELECT app_id, name FROM games WHERE app_id = ?').get(gotwPicks.group_app_id);
    if (game) groupGotW = game;
  }

  return {
    leaderboard: result,
    shared: {
      total_shared_titles: totalShared,
      everyone_owns: everyoneHas,
      total_unique_titles: appCounts.size,
    },
    group_gotw: groupGotW,
  };
}

app.get('/api/leaderboard', requireSetup, (req, res) => {
  const data = computeLeaderboard();
  for (const u of data.leaderboard) delete u.app_ids;
  res.json(data);
});

app.get('/api/users/:id/xp-receipt', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  const receipt = computeUserXpReceipt(userId, getCurrentGotWPicks());
  res.json({ ok: true, user, receipt });
});

// Check if this user is the weekly XP winner and still needs to pick
app.get('/api/users/:id/xp-winner-status', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const winner = getCurrentWeeklyXpWinner();
  if (!winner || winner.user_id !== userId) return res.json({ is_winner: false });

  const needsToPick = !winner.picked_app_id;
  // Mark prompted_at on the first GET if not yet set (so we know they saw the prompt)
  if (needsToPick && !winner.prompted_at) {
    db.prepare(`UPDATE weekly_xp_winners SET prompted_at = ? WHERE week_start_at = ?`)
      .run(Date.now(), winner.week_start_at);
  }
  res.json({
    is_winner: true,
    needs_to_pick: needsToPick,
    xp_gained: winner.xp_gained,
    hours_gained: winner.hours_gained,
    picked_app_id: winner.picked_app_id,
  });
});

// Get the list of unpaid contracts the winner can choose from
app.get('/api/users/:id/xp-winner-options', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const winner = getCurrentWeeklyXpWinner();
  if (!winner || winner.user_id !== userId) return res.status(403).json({ ok: false, error: 'Not the current winner' });

  const currentGotW = getCurrentGotWPicks();
  const groupAppId = currentGotW?.group_app_id || null;
  const options = [];
  for (const r of getEffectiveLedgerEntriesForPlayer(userId, { gotwPicks: currentGotW })) {
    const price = (r.paid_price_cents || 0) / 100;
    const hours = (r.playtime_minutes || 0) / 60;
    if (isUnpaidContractRow(r) && !isGameInSameMergeGroup(userId, r.app_id, groupAppId)) {
      options.push({
        app_id: r.app_id,
        name: r.name,
        hours: Math.round(hours * 10) / 10,
        price: Math.round(price * 100) / 100,
        debt: Math.round((price - hours) * 100) / 100,
        is_merged: !!r.is_merged,
        merge_group_id: r.merge_group_id || null,
        merged_app_ids: r.merged_app_ids || null,
        merged_count: r.merged_count || null,
        merged_games: r.merged_games ? r.merged_games.map(g => ({ app_id: g.app_id, name: g.name })) : null,
      });
    }
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, options });
});

// The winner makes their pick
app.post('/api/users/:id/xp-winner-pick', requireSetup, (req, res) => {
  const userId = parseInt(req.params.id);
  const winner = getCurrentWeeklyXpWinner();
  if (!winner || winner.user_id !== userId) return res.status(403).json({ ok: false, error: 'Not the current winner' });
  if (winner.picked_app_id) return res.status(400).json({ ok: false, error: 'You already picked this week' });

  const appId = parseInt(req.body?.app_id);
  if (!Number.isInteger(appId)) return res.status(400).json({ ok: false, error: 'Valid app_id required' });

  // Verify the game is one of the user's effective unpaid contracts. If a
  // secondary merged app_id is submitted, store the primary/effective app_id.
  const currentGotW = getCurrentGotWPicks() || {};
  const game = getEffectiveLedgerEntriesForPlayer(userId, { gotwPicks: currentGotW })
    .find(r => Number(r.app_id) === appId || (Array.isArray(r.merged_app_ids) && r.merged_app_ids.map(Number).includes(appId)));
  if (!game) return res.status(404).json({ ok: false, error: 'Game not in your library' });
  if (!isUnpaidContractRow(game)) {
    return res.status(400).json({ ok: false, error: 'That game has no debt — pick an unpaid contract' });
  }
  const effectiveAppId = game.app_id;

  // Apply the pick to both tables
  const now = Date.now();
  const personalPicks = { ...(currentGotW.personal_picks || {}) };
  personalPicks[userId] = effectiveAppId;
  const weekStart = now - (now % (7 * 24 * 3600 * 1000));
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
      VALUES (?, ?, ?, ?)`).run(weekStart, currentGotW.group_app_id || null, JSON.stringify(personalPicks), now);
    db.prepare(`UPDATE weekly_xp_winners SET picked_app_id = ?, picked_at = ? WHERE week_start_at = ?`)
      .run(effectiveAppId, now, weekStart);
  })();

  logger.info('XP winner made their pick', { user_id: userId, app_id: effectiveAppId, submitted_app_id: appId, game: game.name });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'xp_winner_pick');
  res.json({ ok: true, app_id: effectiveAppId, game: { name: game.name } });
});

// =====================================================================
// Weekly XP winner — the player who gained the most XP since last Monday
// gets to pick their own personal Game of the Week instead of getting auto-picked.
// =====================================================================
function determineWeeklyXpWinner() {
  // Use last Monday's snapshot as the comparison point.
  // If no snapshot exists (first week), no winner is selected.
  const now = Date.now();
  const oneWeekAgo = now - (7 * 24 * 3600 * 1000);

  // Get the most recent snapshot for each user, taken before "now" but after "two weeks ago"
  const recentSnapshots = db.prepare(`SELECT user_id, MAX(taken_at) AS taken_at FROM leaderboard_snapshots
    WHERE taken_at >= ? AND taken_at < ?
    GROUP BY user_id`).all(oneWeekAgo - (7 * 24 * 3600 * 1000), now);
  if (!recentSnapshots.length) {
    logger.info('Weekly XP winner: no prior snapshots found, skipping winner selection');
    return null;
  }

  const snapshotByUser = new Map();
  for (const s of recentSnapshots) {
    const row = db.prepare('SELECT stats_json FROM leaderboard_snapshots WHERE user_id = ? AND taken_at = ?').get(s.user_id, s.taken_at);
    if (row) {
      try { snapshotByUser.set(s.user_id, JSON.parse(row.stats_json)); } catch {}
    }
  }

  // Compute each user's current XP and hours, compare to snapshot
  const currentBoard = computeLeaderboard();
  const candidates = [];
  for (const u of currentBoard.leaderboard) {
    const snap = snapshotByUser.get(u.id);
    if (!snap) continue;
    const currentXp = u.stats?.xp || 0;
    const prevXp = snap.xp || 0;
    const xpGained = currentXp - prevXp;
    const currentHours = u.stats?.total_hours || 0;
    const prevHours = snap.total_hours || 0;
    const hoursGained = currentHours - prevHours;
    if (xpGained > 0) candidates.push({ user_id: u.id, xp_gained: xpGained, hours_gained: hoursGained, display_name: u.display_name });
  }

  if (!candidates.length) {
    logger.info('Weekly XP winner: no one gained XP this week');
    return null;
  }

  // Highest XP gained wins. Tiebreaker: most hours gained.
  candidates.sort((a, b) => (b.xp_gained - a.xp_gained) || (b.hours_gained - a.hours_gained));
  const winner = candidates[0];

  const weekStart = now - (now % (7 * 24 * 3600 * 1000));
  db.prepare(`INSERT OR REPLACE INTO weekly_xp_winners
    (week_start_at, user_id, xp_gained, hours_gained, picked_app_id, prompted_at, picked_at)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL)`).run(weekStart, winner.user_id, winner.xp_gained, winner.hours_gained);

  logger.info('Weekly XP winner determined', { user_id: winner.user_id, name: winner.display_name, xp_gained: winner.xp_gained, hours_gained: winner.hours_gained });
  return winner;
}

// Get the current week's XP winner, if any. Returns null if no winner this week.
function getCurrentWeeklyXpWinner() {
  const now = Date.now();
  const weekStart = now - (now % (7 * 24 * 3600 * 1000));
  return db.prepare(`SELECT * FROM weekly_xp_winners WHERE week_start_at = ?`).get(weekStart);
}

// =====================================================================
// Games of the Week picker — picks one shared group game + one per player
// Called by cron before the digest, or manually via admin endpoint.
// =====================================================================
function pickGamesOfTheWeek() {
  // Get all users with their unpaid contracts (arrears/outstanding only, not paid/free/exempt)
  const users = db.prepare('SELECT id, display_name FROM users').all();
  if (!users.length) {
    logger.warn('GotW: no users to pick for');
    return { ok: false, error: 'No users' };
  }

  // Build user → set of effective arrears/outstanding app_ids. Manual merge
  // groups are treated as one contract, so Metro Exodus + Enhanced Edition is
  // one candidate after merging, not two duplicate picks.
  const userUnpaid = new Map();
  for (const u of users) {
    const unpaid = new Set();
    for (const r of getEffectiveLedgerEntriesForPlayer(u.id)) if (isUnpaidContractRow(r)) unpaid.add(r.app_id);
    userUnpaid.set(u.id, unpaid);
  }

  // Group game: ideally a game everyone has in arrears.
  // Fallback: a game owned by the MOST players that's in arrears for at least one of them.
  let groupCandidates = null;
  if (users.length >= 2) {
    const intersection = new Set(userUnpaid.get(users[0].id));
    for (let i = 1; i < users.length; i++) {
      const other = userUnpaid.get(users[i].id);
      for (const appId of intersection) if (!other.has(appId)) intersection.delete(appId);
    }
    if (intersection.size > 0) groupCandidates = [...intersection];
  }

  // Fallback: find the app_id with the most players having it unpaid
  if (!groupCandidates || groupCandidates.length === 0) {
    const appCount = new Map();
    for (const [, unpaid] of userUnpaid) {
      for (const appId of unpaid) appCount.set(appId, (appCount.get(appId) || 0) + 1);
    }
    if (appCount.size > 0) {
      const max = Math.max(...appCount.values());
      groupCandidates = [...appCount.entries()].filter(([, c]) => c === max).map(([id]) => id);
    }
  }

  const groupAppId = groupCandidates && groupCandidates.length
    ? groupCandidates[Math.floor(Math.random() * groupCandidates.length)]
    : null;

  // Personal picks: pick one random unpaid contract per user. Avoid picking the same as group if possible.
  // The weekly XP winner is skipped — they get to pick their own (modal on next ledger open).
  const winner = getCurrentWeeklyXpWinner();
  const winnerUserId = winner ? winner.user_id : null;
  const personalPicks = {};
  for (const u of users) {
    if (u.id === winnerUserId) {
      // Skip — winner picks for themselves
      logger.info('GotW: skipped personal pick for XP winner (they pick their own)', { user_id: u.id });
      continue;
    }
    const unpaid = [...userUnpaid.get(u.id)];
    const pool = unpaid.filter(id => !isGameInSameMergeGroup(u.id, id, groupAppId));
    const finalPool = pool.length ? pool : unpaid; // if everything is the group game, allow it
    if (finalPool.length > 0) {
      personalPicks[u.id] = finalPool[Math.floor(Math.random() * finalPool.length)];
    }
  }

  const now = Date.now();
  const weekStart = now - (now % (7 * 24 * 3600 * 1000)); // beginning of week, UTC-rounded
  db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
    VALUES (?, ?, ?, ?)`).run(weekStart, groupAppId, JSON.stringify(personalPicks), now);

  logger.info('Games of the Week picked', { group_app_id: groupAppId, personal_count: Object.keys(personalPicks).length });
  return { ok: true, group_app_id: groupAppId, personal_picks: personalPicks };
}

// =====================================================================
// PHASE 8: Discord weekly digest
// =====================================================================

// Take a snapshot of every user's current stats (for week-over-week comparison)
function takeSnapshots() {
  const data = computeLeaderboard();
  const now = Date.now();
  const stmt = db.prepare('INSERT INTO leaderboard_snapshots (user_id, taken_at, stats_json) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const u of data.leaderboard) {
      stmt.run(u.id, now, JSON.stringify(u.stats));
    }
  })();
  // Trim old snapshots: keep last 12 per user
  const oldRows = db.prepare(`SELECT id FROM leaderboard_snapshots WHERE user_id = ?
    ORDER BY taken_at DESC LIMIT -1 OFFSET 12`);
  const del = db.prepare('DELETE FROM leaderboard_snapshots WHERE id = ?');
  for (const u of data.leaderboard) {
    for (const r of oldRows.all(u.id)) del.run(r.id);
  }
  logger.info('Snapshots taken', { count: data.leaderboard.length });
  return { ok: true, count: data.leaderboard.length };
}

// Build a Discord embed from current state vs the previous snapshot
function buildDigestEmbed() {
  const data = computeLeaderboard();
  const players = data.leaderboard.filter(u => u.stats.games > 0);
  if (!players.length) return { content: 'Backlog Ledger: no players have games yet.', embeds: [] };

  // Pick the most recent snapshot per user, but exclude any within the last 12 hours
  // (so a manual digest fired moments after a snapshot still compares to the prior one).
  const twelveHoursAgo = Date.now() - 12 * 3600 * 1000;
  const prevByUser = new Map();
  for (const u of players) {
    const r = db.prepare(`SELECT stats_json FROM leaderboard_snapshots
      WHERE user_id = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 1`).get(u.id, twelveHoursAgo);
    if (r) {
      try { prevByUser.set(u.id, JSON.parse(r.stats_json)); } catch {}
    }
  }

  const max = (arr, fn) => arr.reduce((a, b) => (fn(b) > fn(a) ? b : a));

  // Sort by settlement rate desc, hours as tiebreak
  const ranked = [...players].sort((a, b) => {
    const sa = a.stats.settlement_rate ?? -1;
    const sb = b.stats.settlement_rate ?? -1;
    if (sa !== sb) return sb - sa;
    return b.stats.total_hours - a.stats.total_hours;
  });

  const top3 = ranked.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];

  // Group totals
  const totalSpent = players.reduce((s, u) => s + u.stats.total_spent_pounds, 0);
  const totalHours = players.reduce((s, u) => s + u.stats.total_hours, 0);
  const totalDebt = players.reduce((s, u) => s + u.stats.total_debt_pounds, 0);
  const totalSettled = players.reduce((s, u) => s + u.stats.counts.paid, 0);
  const totalContracts = players.reduce((s, u) => s + u.stats.counts.contracts, 0);

  // Biggest mover: largest absolute jump in settled contracts since last snapshot
  let mover = null;
  for (const u of players) {
    const prev = prevByUser.get(u.id);
    if (!prev) continue;
    const delta = u.stats.counts.paid - (prev.counts?.paid ?? 0);
    if (!mover || Math.abs(delta) > Math.abs(mover.delta)) {
      mover = { user: u, delta, prev };
    }
  }

  // Hottest (most hours_last_2weeks)
  const hotPlayers = players.filter(u => u.stats.hours_last_2weeks > 0);
  const hottest = hotPlayers.length ? max(hotPlayers, u => u.stats.hours_last_2weeks) : null;

  // Build embed fields
  const standings = top3.map((u, i) => {
    const sr = u.stats.settlement_rate ?? 0;
    return `${medals[i]} **${u.display_name}** — ${sr}% settled (${u.stats.counts.paid}/${u.stats.counts.contracts})`;
  }).join('\n');

  const championLine = ranked[0]
    ? `**${ranked[0].display_name}** holds the line at **${ranked[0].stats.settlement_rate ?? 0}%** of contracts paid off.`
    : '*No champion yet.*';

  let moverLine = '*Not enough history yet.*';
  if (mover && mover.delta !== 0) {
    if (mover.delta > 0) {
      moverLine = `🎯 **${mover.user.display_name}** settled **${mover.delta}** new contract${mover.delta === 1 ? '' : 's'} this week.`;
    } else {
      moverLine = `📉 **${mover.user.display_name}**'s settled count dropped by **${Math.abs(mover.delta)}** (new arrears arrived).`;
    }
  } else if (mover) {
    moverLine = '🤝 Nobody moved a contract this week. The ledger waits.';
  }

  const hottestLine = hottest
    ? `🔥 **${hottest.display_name}** played **${hottest.stats.hours_last_2weeks}h** in the past fortnight.`
    : '*Nobody played anything this fortnight. Disgraceful.*';

  // XP rankings — sort players by XP descending
  const xpRanked = [...players].sort((a, b) => b.stats.xp - a.stats.xp);
  const xpLine = xpRanked.length
    ? xpRanked.map(u => `**${u.display_name}** — ${u.stats.xp.toLocaleString()} XP${u.stats.xp_gotw_bonus > 0 ? ` (incl. +${u.stats.xp_gotw_bonus} GotW bonus)` : ''}`).join('\n')
    : '*No XP earned yet.*';

  // Games of the Week section
  let gotwLine = '*No game picked yet.*';
  if (data.group_gotw) {
    gotwLine = `🎯 **${data.group_gotw.name}** — the contract everyone must answer to.\n` +
               `Hours played here this week earn **x2 XP** for all players.`;
  }
  // Per-player personal picks
  const personalLines = players
    .filter(u => u.personal_gotw)
    .map(u => `• **${u.display_name}**: _${u.personal_gotw.name}_`)
    .join('\n');

  const embed = {
    title: '📜 The Backlog Ledger — Weekly Reckoning',
    description: championLine,
    color: 0xd4a64a, // gold
    fields: [
      { name: '🏆 Standings', value: standings || '*No contracts to settle.*', inline: false },
      { name: '⚡ XP Rankings', value: xpLine.slice(0, 1020), inline: false },
      { name: '🎯 Group Game of the Week', value: gotwLine, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Hours = pounds is the deal. Bonus XP on the GotW.' },
  };
  if (personalLines) {
    embed.fields.push({ name: '🎲 Personal picks', value: personalLines.slice(0, 1020), inline: false });
  }
  embed.fields.push(
    { name: '🎯 This week\'s mover', value: moverLine, inline: false },
    { name: '🔥 Currently hottest', value: hottestLine, inline: false },
    {
      name: '📊 Group totals',
      value: `**${players.length}** players • **${data.shared.total_unique_titles}** unique titles\n` +
             `💰 £${totalSpent.toFixed(2)} spent • ⏰ ${totalHours.toLocaleString()} hours\n` +
             `✅ ${totalSettled}/${totalContracts} contracts settled • ⚖️ £${totalDebt.toFixed(2)} outstanding`,
      inline: false
    }
  );

  return { embeds: [embed] };
}

// Post a payload to the configured Discord channel
async function postToDiscord(payload) {
  const token = getConfig('discord_bot_token');
  const channelId = getConfig('discord_channel_id');
  if (!token || !channelId) return { ok: false, error: 'Discord not configured' };

  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error('Discord post failed', { status: res.status, body: text.slice(0, 200) });
      return { ok: false, error: `Discord HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (err) {
    logger.error('Discord post network error', { error: err.message });
    return { ok: false, error: err.message };
  }
}

// Admin: set/update ITAD API key (can be done after initial setup)
app.post('/api/admin/set-itad-key', requireAdmin, (req, res) => {
  const { itad_api_key } = req.body || {};
  if (itad_api_key) {
    setConfig('itad_api_key', itad_api_key);
    logger.info('ITAD API key updated');
    res.json({ ok: true });
  } else {
    db.prepare("DELETE FROM app_config WHERE key = 'itad_api_key'").run();
    logger.info('ITAD API key cleared');
    res.json({ ok: true, cleared: true });
  }
});

// Admin: check if ITAD key is configured (returns masked key, not the full thing)
app.get('/api/admin/itad-key-status', requireAdmin, (req, res) => {
  const key = getConfig('itad_api_key');
  if (key) {
    const masked = key.slice(0, 6) + '…' + key.slice(-4);
    res.json({ ok: true, has_key: true, masked_key: masked });
  } else {
    res.json({ ok: true, has_key: false });
  }
});

// Admin: test ITAD API with a known game (BioShock Infinite, app_id 8870)
app.get('/api/admin/itad-test', requireAdmin, async (req, res) => {
  const itadKey = getConfig('itad_api_key');
  if (!itadKey) return res.json({ ok: false, error: 'No ITAD key configured' });
  const testAppId = 8870; // BioShock Infinite
  const results = { key_prefix: itadKey.slice(0, 6), steps: [] };
  try {
    // Step 1: Lookup
    const lookupUrl = `https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(itadKey)}&appid=${testAppId}&shop=61`;
    results.steps.push({ step: 'lookup_url', url: lookupUrl.replace(itadKey, 'REDACTED') });
    const lookupRes = await fetch(lookupUrl);
    const lookupText = await lookupRes.text();
    results.steps.push({ step: 'lookup_response', status: lookupRes.status, body: lookupText.slice(0, 500) });
    if (!lookupRes.ok) return res.json({ ok: false, error: `Lookup HTTP ${lookupRes.status}`, results });

    let itadId = null;
    try {
      const d = JSON.parse(lookupText);
      results.steps.push({ step: 'lookup_parsed', found: d?.found, game_id: d?.game?.id, game_title: d?.game?.title });
      if (d?.found && d?.game?.id) itadId = d.game.id;
    } catch (e) {
      results.steps.push({ step: 'lookup_parse_error', error: e.message });
      return res.json({ ok: false, error: 'Failed to parse lookup response', results });
    }

    if (!itadId) return res.json({ ok: false, error: 'Game not found in ITAD', results });

    // Step 2: Historical low
    const histUrl = `https://api.isthereanydeal.com/games/historylow/v1?key=${encodeURIComponent(itadKey)}&country=GB`;
    const histRes = await fetch(histUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([itadId])
    });
    const histText = await histRes.text();
    results.steps.push({ step: 'historylow_response', status: histRes.status, body: histText.slice(0, 800) });

    try {
      const histData = JSON.parse(histText);
      results.steps.push({ step: 'historylow_parsed', data: histData });
    } catch (e) {
      results.steps.push({ step: 'historylow_parse_error', error: e.message });
    }

    res.json({ ok: true, results });
  } catch (err) {
    results.steps.push({ step: 'error', message: err.message });
    res.json({ ok: false, error: err.message, results });
  }
});

// Manual digest endpoint (admin-only, fires immediately without affecting cron)
app.post('/api/admin/post-digest', requireAdmin, async (req, res) => {
  try {
    const payload = buildDigestEmbed();
    const result = await postToDiscord(payload);
    if (!result.ok) return res.status(500).json(result);
    logger.info('Manual digest posted to Discord');
    res.json({ ok: true });
  } catch (err) {
    logger.error('Manual digest failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual snapshot endpoint (admin-only) for testing/setup
app.post('/api/admin/take-snapshot', requireAdmin, (req, res) => {
  try {
    const result = takeSnapshots();
    res.json(result);
  } catch (err) {
    logger.error('Manual snapshot failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: manually pick Games of the Week (overrides any pending pick)
app.post('/api/admin/pick-gotw', requireAdmin, (req, res) => {
  try {
    const result = pickGamesOfTheWeek();
    res.json(result);
  } catch (err) {
    logger.error('Manual GotW pick failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: get current weekly XP winner status (for debug page display)
app.get('/api/admin/xp-winner', requireAdmin, (req, res) => {
  const winner = getCurrentWeeklyXpWinner();
  if (!winner) return res.json({ ok: true, winner: null });
  const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(winner.user_id);
  let pickedGame = null;
  if (winner.picked_app_id) {
    pickedGame = db.prepare('SELECT app_id, name FROM games WHERE app_id = ?').get(winner.picked_app_id);
  }
  res.json({ ok: true, winner: { ...winner, user, picked_game: pickedGame } });
});

// Admin: manually run the winner determination right now
app.post('/api/admin/determine-xp-winner', requireAdmin, (req, res) => {
  try {
    const winner = determineWeeklyXpWinner();
    res.json({ ok: true, winner });
  } catch (err) {
    logger.error('Manual winner determination failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: override the winner (set a specific user as this week's winner)
app.post('/api/admin/set-xp-winner', requireAdmin, (req, res) => {
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId)) return res.status(400).json({ ok: false, error: 'Valid user_id required' });
  const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  const now = Date.now();
  const weekStart = now - (now % (7 * 24 * 3600 * 1000));
  db.prepare(`INSERT OR REPLACE INTO weekly_xp_winners
    (week_start_at, user_id, xp_gained, hours_gained, picked_app_id, prompted_at, picked_at)
    VALUES (?, ?, 0, 0, NULL, NULL, NULL)`).run(weekStart, userId);
  // Also remove their auto-picked personal GotW so they're prompted to pick
  const currentGotW = getCurrentGotWPicks() || {};
  const personalPicks = { ...(currentGotW.personal_picks || {}) };
  delete personalPicks[userId];
  delete personalPicks[String(userId)];
  db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
    VALUES (?, ?, ?, ?)`).run(weekStart, currentGotW.group_app_id || null, JSON.stringify(personalPicks), now);
  logger.info('XP winner overridden by admin', { user_id: userId, name: user.display_name });
  res.json({ ok: true, user });
});

// Admin: clear this week's winner (no one picks)
app.delete('/api/admin/xp-winner', requireAdmin, (req, res) => {
  const now = Date.now();
  const weekStart = now - (now % (7 * 24 * 3600 * 1000));
  const result = db.prepare(`DELETE FROM weekly_xp_winners WHERE week_start_at = ?`).run(weekStart);
  logger.info('XP winner cleared by admin', { changes: result.changes });
  res.json({ ok: true, cleared: result.changes > 0 });
});

// Admin: manually set one player's personal Game of the Week.
// This preserves the current group pick and everyone else's personal picks.
app.post('/api/admin/set-personal-gotw', requireAdmin, (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    const appIdRaw = req.body?.app_id;
    const appId = appIdRaw === null || appIdRaw === '' || appIdRaw === undefined ? null : Number(appIdRaw);

    if (!Number.isInteger(userId)) return res.status(400).json({ ok: false, error: 'Valid user_id required' });
    if (appId !== null && !Number.isInteger(appId)) return res.status(400).json({ ok: false, error: 'Valid app_id required' });

    const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ ok: false, error: 'Profile not found' });

    let game = null;
    if (appId !== null) {
      game = db.prepare(`SELECT g.app_id, g.name, ug.playtime_minutes, ug.paid_price_cents, ug.play_status
        FROM user_games ug JOIN games g ON g.app_id = ug.app_id
        WHERE ug.user_id = ? AND ug.app_id = ?`).get(userId, appId);
      if (!game) return res.status(404).json({ ok: false, error: 'Game not found in that player library' });
    }

    const now = Date.now();
    const weekStart = now - (now % (7 * 24 * 3600 * 1000));
    const existing = db.prepare('SELECT week_start_at, group_app_id, personal_picks_json FROM games_of_week ORDER BY week_start_at DESC LIMIT 1').get();

    let rowWeekStart = weekStart;
    let groupAppId = null;
    let personalPicks = {};
    if (existing) {
      rowWeekStart = existing.week_start_at;
      groupAppId = existing.group_app_id;
      try { personalPicks = JSON.parse(existing.personal_picks_json || '{}'); } catch { personalPicks = {}; }
    }

    if (appId === null) delete personalPicks[userId];
    else personalPicks[userId] = appId;

    db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
      VALUES (?, ?, ?, ?)`).run(rowWeekStart, groupAppId, JSON.stringify(personalPicks), now);

    logger.info('Personal GotW manually updated', { user_id: userId, app_id: appId });
    if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(userId, 'personal-gotw');

    res.json({
      ok: true,
      user_id: userId,
      display_name: user.display_name,
      app_id: appId,
      game: game ? { app_id: game.app_id, name: game.name } : null,
      cleared: appId === null,
    });
  } catch (err) {
    logger.error('Manual personal GotW update failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: reroll JUST the group GotW (keeps personal picks intact)
app.post('/api/admin/reroll-group-gotw', requireAdmin, (req, res) => {
  try {
    const current = getCurrentGotWPicks() || {};
    const users = db.prepare('SELECT id FROM users').all();
    const userUnpaid = new Map();
    for (const u of users) {
      const unpaid = new Set();
      for (const r of getEffectiveLedgerEntriesForPlayer(u.id, { gotwPicks: current })) if (isUnpaidContractRow(r)) unpaid.add(r.app_id);
      userUnpaid.set(u.id, unpaid);
    }
    let candidates = null;
    if (users.length >= 2) {
      const intersection = new Set(userUnpaid.get(users[0].id));
      for (let i = 1; i < users.length; i++) {
        const other = userUnpaid.get(users[i].id);
        for (const appId of intersection) if (!other.has(appId)) intersection.delete(appId);
      }
      if (intersection.size > 0) candidates = [...intersection];
    }
    if (!candidates || !candidates.length) {
      const appCount = new Map();
      for (const [, unpaid] of userUnpaid) for (const appId of unpaid) appCount.set(appId, (appCount.get(appId) || 0) + 1);
      if (appCount.size > 0) {
        const max = Math.max(...appCount.values());
        candidates = [...appCount.entries()].filter(([, c]) => c === max).map(([id]) => id);
      }
    }
    if (candidates && candidates.length > 1 && current.group_app_id) {
      const filtered = candidates.filter(id => id !== current.group_app_id);
      if (filtered.length) candidates = filtered;
    }
    const newGroupAppId = candidates?.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    const now = Date.now();
    const weekStart = now - (now % (7 * 24 * 3600 * 1000));
    db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
      VALUES (?, ?, ?, ?)`).run(weekStart, newGroupAppId, JSON.stringify(current.personal_picks || {}), now);
    logger.info('Group GotW rerolled', { new_app_id: newGroupAppId });
    if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(null, 'gotw_reroll_group');
    res.json({ ok: true, group_app_id: newGroupAppId });
  } catch (err) {
    logger.error('Group GotW reroll failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recalculate XP and optionally sync all users first. This can contact Steam and
// mutate sync state, so keep it behind the admin password.
app.post('/api/recalculate-xp', requireSetup, requireAdmin, async (req, res) => {
  const syncFirst = req.body?.sync !== false; // default true
  const out = { synced: [], errors: [], xp: [] };
  if (syncFirst) {
    const users = db.prepare('SELECT id, display_name FROM users WHERE steam_id IS NOT NULL').all();
    for (const u of users) {
      try {
        // Respect the same 30s rate limit as manual sync (but skip if we recently synced)
        const lastSync = db.prepare('SELECT synced_at FROM sync_log WHERE user_id = ? AND status = ? ORDER BY synced_at DESC LIMIT 1').get(u.id, 'ok');
        if (lastSync && Date.now() - lastSync.synced_at < 60 * 1000) {
          out.synced.push({ user_id: u.id, name: u.display_name, skipped: 'recent' });
          continue;
        }
        const result = await syncUserLibrary(u.id);
        if (result.ok) out.synced.push({ user_id: u.id, name: u.display_name, added: result.added, updated: result.updated });
        else out.errors.push({ user_id: u.id, name: u.display_name, error: result.error });
        // Be polite to Steam API
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        out.errors.push({ user_id: u.id, name: u.display_name, error: err.message });
      }
    }
  }

  // Now read XP for every user
  const board = computeLeaderboard();
  out.xp = board.leaderboard.map(u => ({
    user_id: u.id, name: u.display_name,
    xp: u.stats.xp, xp_contracts: u.stats.xp_contracts, xp_gotw_bonus: u.stats.xp_gotw_bonus
  }));

  logger.info('Recalculate XP run', { synced: out.synced.length, errors: out.errors.length });
  if (app.locals.broadcastLeaderboardUpdate) app.locals.broadcastLeaderboardUpdate(null, 'recalculate-xp');
  res.json({ ok: true, ...out });
});

// Cron: weekly snapshot every Monday 9am UTC
cron.schedule('0 9 * * 1', () => {
  logger.info('Weekly snapshot cron triggered (Monday 9am UTC)');
  try { takeSnapshots(); } catch (err) { logger.error('Snapshot cron failed', { error: err.message }); }
}, { timezone: 'Etc/UTC' });

// Cron: pick Games of the Week every Wednesday 6:55pm UTC (5 min before digest).
// Step 1: determine the weekly XP winner (so their personal pick is skipped).
// Step 2: pick GotW with winner's slot empty.
cron.schedule('55 18 * * 3', () => {
  logger.info('GotW pick cron triggered (Wednesday 6:55pm UTC)');
  try {
    determineWeeklyXpWinner();
    pickGamesOfTheWeek();
  } catch (err) { logger.error('GotW pick cron failed', { error: err.message }); }
}, { timezone: 'Etc/UTC' });

// Cron: Friday 6pm UTC — if the weekly XP winner still hasn't picked their personal GotW,
// auto-pick for them so they don't have an empty slot all week.
cron.schedule('0 18 * * 5', () => {
  logger.info('Weekly XP winner deadline cron triggered (Friday 6pm UTC)');
  try {
    const winner = getCurrentWeeklyXpWinner();
    if (!winner || winner.picked_app_id) return;
    // Auto-pick from their effective unpaid contracts (matching the normal picker logic).
    const currentGotW = getCurrentGotWPicks();
    const groupApp = currentGotW?.group_app_id || null;
    const unpaid = getEffectiveLedgerEntriesForPlayer(winner.user_id, { gotwPicks: currentGotW })
      .filter(r => isUnpaidContractRow(r))
      .filter(r => !isGameInSameMergeGroup(winner.user_id, r.app_id, groupApp))
      .map(r => r.app_id);
    if (!unpaid.length) {
      logger.warn('XP winner deadline: no unpaid contracts available to auto-pick');
      return;
    }
    const pick = unpaid[Math.floor(Math.random() * unpaid.length)];
    // Update both tables
    const personalPicks = { ...(currentGotW?.personal_picks || {}) };
    personalPicks[winner.user_id] = pick;
    const now = Date.now();
    const weekStart = now - (now % (7 * 24 * 3600 * 1000));
    db.prepare(`INSERT OR REPLACE INTO games_of_week (week_start_at, group_app_id, personal_picks_json, picked_at)
      VALUES (?, ?, ?, ?)`).run(weekStart, currentGotW?.group_app_id || null, JSON.stringify(personalPicks), now);
    db.prepare(`UPDATE weekly_xp_winners SET picked_app_id = ?, picked_at = ? WHERE week_start_at = ?`)
      .run(pick, now, weekStart);
    logger.info('XP winner deadline: auto-picked personal GotW', { user_id: winner.user_id, app_id: pick });
  } catch (err) { logger.error('XP winner deadline cron failed', { error: err.message }); }
}, { timezone: 'Etc/UTC' });

// Cron: weekly digest every Wednesday 7pm UTC (30min after the Steam sync at 6:30pm)
cron.schedule('0 19 * * 3', async () => {
  logger.info('Weekly digest cron triggered (Wednesday 7pm UTC)');
  try {
    const payload = buildDigestEmbed();
    const result = await postToDiscord(payload);
    if (result.ok) logger.info('Weekly digest posted');
    else logger.error('Weekly digest failed', { error: result.error });
  } catch (err) { logger.error('Digest cron failed', { error: err.message }); }
}, { timezone: 'Etc/UTC' });

logger.info('Scheduled jobs registered: snapshots (Mon 9am UTC), digest (Wed 7pm UTC)');


// ---------- Start ----------
// We track the actual port the server ended up on (which may differ from PORT
// if 47821 was in use at boot). The wizard reads this via /api/setup/status
// so first-run users can always reach the installer, even on a busy machine.
let ACTIVE_PORT = null;

// Probe whether `port` is bindable right now by briefly opening + closing a socket on it.
// Used to validate a port the wizard wants to switch to BEFORE we close the current listener.
function probePort(port) {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(false); // any error → treat as unavailable
    });
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    try { probe.listen(port); } catch { resolve(false); }
  });
}

// Listen on `port`. Rejects with the original error if it's not EADDRINUSE.
function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

// Try the preferred port first, walk forward a small range, then let the OS pick.
// This means a busy 47821 (or whatever the user previously configured) never blocks
// first-run setup — the user can always reach the wizard and pick a different port.
async function listenWithFallback(server, preferred) {
  const tried = [];
  const candidates = [preferred];
  for (let i = 1; i <= 9; i++) candidates.push(preferred + i);
  candidates.push(0); // OS-assigned as the last resort
  for (const candidate of candidates) {
    try {
      const actual = await listenOnPort(server, candidate);
      return { port: actual, fallback: actual !== preferred, tried };
    } catch (err) {
      tried.push({ port: candidate, error: err.code || err.message });
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('Could not find an available port: ' + JSON.stringify(tried));
}

function logBanner() {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║       The Backlog Ledger — v${VERSION}          ║`);
  console.log(`║  Running at: http://localhost:${ACTIVE_PORT}`);
  console.log(`║  Setup:      ${isSetupComplete() ? 'complete' : 'required (visit URL above)'}`);
  if (ACTIVE_PORT !== PORT) {
    console.log(`║  NOTE:       configured port ${PORT} was in use,`);
    console.log(`║              fell back to ${ACTIVE_PORT}`);
  }
  console.log(`╚════════════════════════════════════════════╝\n`);
  logger.info(`Server listening on port ${ACTIVE_PORT}` + (ACTIVE_PORT !== PORT ? ` (fallback from ${PORT})` : ''));
}

(async () => {
  try {
    const result = await listenWithFallback(httpServer, PORT);
    ACTIVE_PORT = result.port;
    logBanner();
  } catch (err) {
    logger.fatal('Unable to bind to any port', { error: err.message });
    console.error('FATAL: could not start the server —', err.message);
    process.exit(1);
  }
})();

process.on('SIGINT', () => { logger.info('Shutdown requested'); db.close(); process.exit(0); });
