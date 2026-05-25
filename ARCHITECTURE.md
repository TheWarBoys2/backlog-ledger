# The Backlog Ledger — Technical Architecture

This document explains how the Backlog Ledger works internally: data model, request flow, scheduled jobs, and the design decisions behind each subsystem. For end-user / setup documentation, see `README.md`.

---

## Overview

The app is a single Node.js process serving:

- A static frontend (vanilla HTML/CSS/JS) from `public/`
- A REST API (Express) backed by SQLite
- A Socket.IO server for real-time leaderboard updates
- Scheduled cron jobs for snapshots, syncs, Games of the Week, XP winners, and the weekly Discord digest

There is no build step, no transpiler, no framework on the client. Everything is hand-rolled JavaScript.

### Top-level layout

```
backlog-ledger/
├── server.js          ← the entire backend (~3000 lines, intentionally one file)
├── package.json       ← dependencies and start scripts
├── README.md          ← user-facing docs
├── ARCHITECTURE.md    ← this file
├── .gitignore
├── backlog.db         ← SQLite database (created at runtime, NOT in repo)
├── config.json        ← port + minor config (created at runtime)
├── logs/              ← daily rotating log files (created at runtime)
└── public/
    ├── index.html         ← The Ledger (main view)
    ├── leaderboard.html   ← Multi-player leaderboard
    ├── import.html        ← Combined purchase history + licence importer
    ├── import-licenses.html ← Redirect stub
    ├── profile-edit.html  ← Profile settings, Steam accounts manager
    ├── profiles.html      ← Profile picker
    ├── setup.html         ← First-run wizard
    ├── debug.html         ← Admin dashboard
    ├── library.html       ← Read-only game list
    ├── style.css          ← Single themed stylesheet
    └── js/app.js          ← Shared helpers (cookie-based profile selector)
```

### Why one big `server.js`?

It's a self-hosted weekend project for a friend group. Splitting it into modules would help in a larger codebase but adds friction here. Everything is searchable via `grep`, and the file has clear section markers (`---------- PHASE N ----------`) that let you find subsystems quickly.

---

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | Built-in `fetch()`, no polyfills needed |
| HTTP | Express 4 | Minimal middleware |
| Database | better-sqlite3 | Synchronous API, fast, single-file DB |
| Real-time | Socket.IO | Used only for "leaderboard changed, refresh" pushes |
| Cron | node-cron | UTC-pinned schedules |
| Discord | discord.js | Bot posts the weekly digest |
| Frontend | Vanilla JS + CSS | No build, no React, no bundler |

Dependencies are intentionally minimal — see `package.json`.

---

## Database schema

SQLite single-file database (`backlog.db`) with WAL mode and foreign keys enabled. Schema is defined inline in `server.js` as the `SCHEMA` constant and applied on startup with `db.exec(SCHEMA)`. All `CREATE TABLE IF NOT EXISTS` so it's idempotent.

### Tables

#### `app_config`
Key/value config. Stores Steam API key, Discord bot token, ITAD key, admin password hash, group name, setup completion timestamp. Read via `getConfig(key)` and written via `setConfig(key, value)`.

#### `users`
The profile. One row per player. Holds display name, **primary** `steam_id`, Discord user ID, avatar URL, `created_at`, `last_synced_at`.

The `steam_id` column is kept for backward compatibility with code that reads "the user's Steam ID" — it always matches the oldest row in `user_steam_accounts` for this user (the primary). When the primary account is removed, this column is updated to point at the next-oldest remaining account.

#### `user_steam_accounts`
Multiple Steam accounts per profile (added later via migration). Each row:
- `id` (PK) — referenced by `user_games.steam_account_id`
- `user_id` (FK → users)
- `steam_id` (UNIQUE across the whole table — one Steam ID can't be linked to two profiles)
- `label` — user-friendly name like "Main", "Alt", "Family"
- `persona_name` — Steam display name at link time
- `avatar_url`, `added_at`, `last_synced_at`

Idempotent migration backfills this from existing `users.steam_id` rows on first start after the multi-account feature was added.

#### `games`
The global game catalog. One row per Steam app_id. Negative app_ids = custom (non-Steam) games. The same `app_id` row is shared across all users (the name is global).

#### `user_games`
The join table — what each user owns and tracks per-game. Composite primary key `(user_id, app_id)` historically; multi-account complicates this slightly because the same user can own the same game on two different Steam accounts.

To keep the existing PK working, the **second occurrence** of an `(user_id, app_id)` pair is allowed only because of how SQLite handles inserts during sync — see "Multi-account & user_games" below for the actual storage model.

Columns:
- `playtime_minutes`, `playtime_last_2weeks` — from Steam
- `paid_price_cents` — how much they paid (from purchase import or manual edit)
- `play_status` — one of `unplayed`, `playing`, `completed`, `exempt`, `free`
- `manual_override` — boolean: don't let sync overwrite playtime
- `completed_at` — timestamp if manually marked complete
- `notes` — free text
- `price_is_estimated` (boolean), `price_estimate_source` (string) — for estimated prices
- `steam_account_id` — which linked Steam account this row belongs to

#### `sync_log`
History of every Steam sync attempt — timestamp, games added/updated, status, error. Truncated to last 10 entries when fetched.

#### `pending_prices`
Old fallback table used when a purchase import row didn't match any owned game. Largely superseded by `import_decisions` and the modal-based resolver.

#### `leaderboard_snapshots`
Weekly statistics captured every Monday 9 AM UTC. JSON blob of each user's stats at that moment — used for week-over-week comparisons in the Discord digest and for determining the weekly XP winner.

#### `match_overrides`
Memory of "this raw name (from a Steam purchase line) maps to this app_id". Lets re-imports skip the manual matching step. Keyed on lowercase raw name.

#### `import_decisions`
Richer than `match_overrides`. Tracks the full action the user took for each row during an import: matched to one game, matched to bundle, ignored, or saved as custom. Lets the profile-edit page show a "review saved matches" UI.

#### `xp_baseline` and `xp_baseline_backup`
Per-game starting playtime captured on first sync. XP earned = current playtime minus baseline. The `_backup` table is keyed on `steam_id` (not `user_id`) so baselines survive profile deletion: if you delete and recreate a profile linked to the same Steam ID, the original baselines are restored.

When a new Steam account is linked, its own starting playtime is **added to** the existing baseline (rather than replacing it) so the user doesn't get retroactive XP for hours played before they linked the account.

#### `games_of_week`
One row per week. Stores the group game's app_id and a JSON object mapping `user_id` → `app_id` for personal picks. Primary key is `week_start_at` (epoch ms of Monday 00:00 UTC).

#### `weekly_xp_winners`
One row per week. Records who gained the most XP, how much, and whether they've made their personal-GotW pick yet. PK is `week_start_at`.

### Migrations

There's no Knex/Prisma. Schema changes happen in two places:

1. New tables/columns are added to the `SCHEMA` constant (so fresh installs get them automatically)
2. For columns added to existing tables, an idempotent migration block runs after `db.exec(SCHEMA)`:

```js
const cols = db.prepare("PRAGMA table_info(user_games)").all();
if (!cols.some(c => c.name === 'price_is_estimated')) {
  db.exec('ALTER TABLE user_games ADD COLUMN ...');
}
```

All migrations are safe to re-run. The current schema additions:
- `user_games.price_is_estimated` (boolean)
- `user_games.price_estimate_source` (text)
- `user_games.steam_account_id` (integer)
- Backfill of `user_steam_accounts` from existing `users.steam_id` data

---

## Authentication & authorisation

Deliberately minimal — this is a self-hosted app for a friend group, not a public service.

### What's protected

- **Setup wizard** is accessible to anyone until setup is complete; after that, `/api/setup/complete` rejects further calls.
- **Most user routes** (`GET /api/users/:id/games`, `POST /api/users/:id/sync`, profile edit, etc.) are gated only by `requireSetup` — anyone who can reach the server can read or modify anything for any profile. This is intentional: the host runs it locally / on their LAN / behind a reverse proxy, and friends are trusted.
- **Admin routes** (`/api/admin/*` and `DELETE /api/users/:id`) require an admin password sent in the `x-admin-password` header, checked by `requireAdmin` middleware against the hashed password in `app_config`.

### Password hashing

`scrypt` (built into Node's `crypto` module) with a fixed salt. Not ideal — a per-record salt would be standard — but this is fine for a single admin password on a self-hosted box.

```js
const hashPassword = (pw) => crypto.scryptSync(pw, 'backlog-ledger-salt', 64).toString('hex');
```

If you ever expose this to the open internet, change the salt to per-record and add rate limiting.

---

## Request flow: a typical Ledger load

What happens when someone opens `/index.html`:

1. Browser loads HTML + CSS + inline JS
2. JS reads the current profile ID from a cookie (`BL.getProfile()` in `public/js/app.js`)
3. `reload()` runs, firing two parallel fetches:
   - `GET /api/users/:id/games` → all games + stats + linked accounts
   - `GET /api/leaderboard` → XP totals + this week's Games of the Week
4. Frontend computes contract classifications client-side (paid, arrears, outstanding, etc.) using the same logic the server uses for stats
5. Renders the ledger rows, GotW strip, stats bar
6. Checks `GET /api/users/:id/xp-winner-status` — if user is the weekly winner and hasn't picked, opens the modal
7. Connects to Socket.IO (`socket.io`), listens for `leaderboard:update` events
8. When any other user syncs/edits a game, the server broadcasts the event, and this page reloads silently

There's no router, no virtual DOM, no state management library. The page is reloaded with a full re-render when data changes (cheap because all the data is already in browser memory).

---

## The contract model

This is the core abstraction of the app:

> Each paid game is a contract: **£1 of price = 1 hour owed.** You "pay off" the contract by playing.

Implementation:

```
hours = playtime_minutes / 60
price = paid_price_cents / 100
debt  = max(0, price - hours)

kind  =
  exempt     if play_status = 'exempt'
  completed  if play_status = 'completed' (settled regardless of hours)
  free       if price = 0  (no obligation)
  paid       if hours >= price
  arrears    if 0 < hours < price
  outstanding if hours = 0 and price > 0
```

Used identically on the client (`classify(game)` in `public/index.html`) and the server (in the leaderboard computation). Sources of truth must stay consistent — if you change one, change both.

### Multi-account aggregation

When a user has the same game on multiple Steam accounts, the system **sums** values:

- Total hours played across all accounts
- Total price paid across all accounts
- Status: completed > exempt > free > playing > unplayed (highest priority wins)

The rationale: hours represent the person's engagement (you played 55 hours of game-time across two accounts = 55 hours of real life). Price represents the person's financial commitment (if you accidentally bought it twice, you actually spent both amounts). A game is settled when **total hours ≥ total price**.

This aggregation happens at the boundary between the database and the API response. The `user_games` table stores per-account rows; the `GET /api/users/:id/games` endpoint and `computeLeaderboard()` both run an aggregation pass that merges by `app_id` before returning data. The frontend never sees the per-account split unless it explicitly asks for the breakdown.

---

## Sync (Steam library import)

Triggered by:
- Manual click in the UI (`POST /api/users/:id/sync`)
- Single-account sync (`POST /api/users/:id/steam-accounts/:accountId/sync`)
- Wednesday 6:30 PM UTC cron (auto-sync all users before the weekly digest)

### What it does, per Steam account

1. Calls Steam's `GetOwnedGames` API with the account's `steam_id` and the host's API key
2. Receives an array of `{ appid, name, playtime_forever, playtime_2weeks }`
3. Wraps everything in a single transaction:
   - Upserts each game into `games`
   - For each game, inserts or updates the matching `user_games` row (scoped to this `steam_account_id`)
   - Skips rows where `manual_override = 1` so manually-edited playtimes survive sync
   - Sets the XP baseline if not yet set (`INSERT OR IGNORE INTO xp_baseline`)
   - If a baseline already exists from another account (multi-account case), **bumps** the baseline by this account's starting minutes so prior playtime doesn't retroactively earn XP
   - Writes a `sync_log` row
4. Updates `users.last_synced_at` and `user_steam_accounts.last_synced_at`
5. Broadcasts a Socket.IO event so other clients refresh

### Sync rate limiting

`POST /api/users/:id/sync` is rate-limited server-side: `SYNC_RATE_LIMIT_MS` (default 60 seconds) between syncs per user. This prevents accidental hammering of Steam's API.

### Auto-sync cron

`30 18 * * 3` (Wednesday 6:30 PM UTC). Iterates every user and runs `syncUserLibrary()` sequentially with a 500ms gap between accounts. Designed to finish before the digest cron at 7 PM.

### Private profile handling

Steam returns an empty response for private profiles. The sync detects this and writes a clear error to `sync_log`. The UI shows the error in the sync history.

---

## Imports (purchase history + Steam licences)

The unified `/import.html` page handles both flows:
- **Purchase history** (from `store.steampowered.com/account/history/`) sets prices
- **Steam licences** (from `store.steampowered.com/account/licenses/`) marks gifts and complimentary entries as free

### Parse phase

Pasted text → `POST /api/users/:id/parse-history` or `parse-licenses` → returns an array of matched rows with suggested app_id matches.

Both parsers are pure functions over text input. They detect dates, prices, item names, and acquisition methods (for licences). Bundles are detected by trailing parenthesised item lists or the explicit "(N items)" pattern.

### Matching

For each parsed row, the server tries to match the item name to a game in the user's library, using:
1. Exact-match in `match_overrides` (user said before "this name = that game")
2. `import_decisions` entry from a previous import (whether it was matched, ignored, or made custom)
3. Fuzzy name matching against `user_games` joined with `games`

The user can override any match in the review step. Their choices are saved into both `match_overrides` (for fast future matching) and `import_decisions` (for the "manage saved matches" UI).

### Apply phase

`POST /api/users/:id/import-history` writes prices. Key invariant: **re-importing is safe**.
- For each app_id, the import takes `MAX(currently stored price, newly imported price)`
- Multiple rows in the same import that target the same app_id are summed (bundles, DLC packs)
- The combination of MAX-vs-stored + SUM-within-batch means buying the same game twice gives you the higher total, and importing the same purchase history twice doesn't double-count

`POST /api/users/:id/import-licenses` marks rows as free *only* if they're `Gift/Guest Pass` or `Complimentary`. Retail/key activations are left alone so the price estimator can still try to find a fair value for them. Purchase evidence (`paid_price_cents > 0`) outranks a complimentary licence — if you bought it, no licence import will mark it free.

Both endpoints accept a `steam_account_id` parameter (for the new INSERT path) so imports are tagged to the correct account.

---

## Price estimation

When games have no price set (paid_price_cents = 0 or NULL), the system can estimate one. Triggered by the "≈ Estimate prices" button on the Ledger.

### Two-tier system

**Tier 1: IsThereAnyDeal** (if API key configured)
- `GET https://api.isthereanydeal.com/games/lookup/v1?key=KEY&appid=X&shop=61` — resolves Steam app ID → ITAD game ID (one game at a time)
- `POST https://api.isthereanydeal.com/games/historylow/v1?key=KEY&country=GB` — batch up to 200 ITAD IDs, returns historical lowest price for each across all tracked stores
- The estimated price is the all-time historical low; the source string records which store had it ("Historical low: £2.20 at MacGameStore (via IsThereAnyDeal)")

**Tier 2: Steam appdetails** (fallback for anything ITAD didn't find)
- `GET https://store.steampowered.com/api/appdetails?appids=X&cc=gb`
- Returns current store price (after any active sale)
- Source string: "Current Steam store price: £X.XX"

### Re-estimation

The button sends `re_estimate: true`, which includes previously-estimated games in the candidate list. This lets users refresh old Steam-fallback prices with new ITAD historical lows once they've added the API key.

Manually entered prices (`price_is_estimated = 0`) are never overwritten — only previously-estimated values get refreshed.

### Genuinely free games

If Steam reports `is_free: true` for a game, the system marks it as `play_status = 'free'` (not estimated). This prevents free-to-play games like Path of Exile or Warframe from appearing as outstanding contracts forever.

---

## XP system

Players earn XP for playing unpaid games. The rule:

> **1 XP per hour played, on contracts that aren't yet paid off, since the player's first sync.**
> **1.5x multiplier for hours played on the current Games of the Week.**

### Baselines

When a user first syncs a game, the current `playtime_minutes` becomes their **baseline**. XP is computed against the delta from that baseline:

```
delta_minutes = current_minutes - baseline_minutes
```

Only the portion of `delta_minutes` played *while the contract was still unpaid* counts. Once `playtime_minutes >= price_in_hours_minutes`, no more XP accrues from that game.

### Why baselines exist

So the app doesn't retroactively credit thousands of hours played before you started using it. Without baselines, anyone with a long Steam history would have astronomical XP on day one.

### Baseline backup

Stored separately in `xp_baseline_backup` keyed on `steam_id` so deleting and recreating a profile doesn't destroy the baseline data. When a new profile is created and synced, the system checks the backup for matching `steam_id` rows and restores them.

### Baseline bump for new accounts

When a user adds a second Steam account that has games already played (and those games already have a baseline from the first account), the baseline is bumped upward by the new account's starting playtime. This way, hours played before the second account was linked don't retroactively earn XP.

### GotW multiplier

When computing XP, the system checks if the game is the user's personal pick or the group's pick for the current week. If so, the XP earned this week from that game gets a 1.5x multiplier.

This is computed at read time (not stored). The XP receipt endpoint (`GET /api/users/:id/xp-receipt`) returns a per-game breakdown showing the multiplier applied to each entry.

---

## Games of the Week

Weekly mechanic to focus the group on specific titles.

### Two kinds

- **Group game**: one shared title. Picked algorithmically to maximise the intersection of "games at least one person owes hours on" across the group. If there's no perfect intersection (no single game everyone owes on), falls back to "the game most users have in arrears".
- **Personal pick**: one game per player, randomly chosen from their own unpaid contracts. Avoids picking the same game as the group pick when possible.

### Schedule

| Time | Job |
|---|---|
| Wed 6:30 PM UTC | Auto-sync all Steam libraries |
| Wed 6:50 PM UTC | Determine weekly XP winner |
| Wed 6:55 PM UTC | Pick Games of the Week (skipping the winner's personal slot) |
| Wed 7:00 PM UTC | Post Discord digest |
| Fri 6:00 PM UTC | Deadline — if XP winner hasn't picked, auto-pick for them |

The 5-minute gap between snapshot and digest exists so a slow sync doesn't push the picker after the digest has already gone out.

### Auto-reroll on settlement

When a user settles their personal GotW (pays it off or marks it complete), the system immediately picks a new personal game from their remaining unpaid contracts. The group game does NOT auto-reroll — only personal picks do.

The auto-reroll fires inside the PATCH endpoint that updates the game's status or playtime. It checks: was this game the user's personal GotW? If yes, is the game now settled (completed/exempt/paid off)? If yes, pick a new one and update `games_of_week.personal_picks_json` in the same response cycle.

### Manual admin controls

The debug page provides:
- "Pick Games of the Week now" — force the picker to run immediately
- "Reroll group game only" — change the group pick, keep personal picks
- "Reroll this player's pick" — change one player's personal pick
- "Set as winner" / "Clear winner" — override the weekly XP winner

---

## Weekly XP winner

Each Wednesday the system determines who gained the most XP since the previous Monday's snapshot. That person gets to **choose** their personal Game of the Week for the next week (instead of having one randomly assigned).

### Determination

1. Pull the most recent `leaderboard_snapshots` row per user from the last 7-14 days
2. For each user, compute `xp_gained = current_xp - snapshot_xp`
3. The user with the highest positive `xp_gained` wins. Ties broken by `hours_gained`.
4. If nobody gained XP, or no snapshots exist (first week), no winner is recorded.

### Picking flow

1. Wednesday cron records winner in `weekly_xp_winners` (PK = `week_start_at`, `picked_app_id = NULL`)
2. `pickGamesOfTheWeek()` runs immediately after — checks for a current winner and **skips** their slot in `personal_picks_json`
3. Next time the winner opens the Ledger, `GET /api/users/:id/xp-winner-status` returns `needs_to_pick: true`
4. Frontend shows a modal with a searchable list of unpaid contracts (`GET /api/users/:id/xp-winner-options`)
5. They click one → `POST /api/users/:id/xp-winner-pick` validates the game is actually unpaid (server-side check, can't be bypassed by tampering with the request) and saves the pick
6. The pick is written to both `weekly_xp_winners.picked_app_id` AND `games_of_week.personal_picks_json` in a single transaction

### Friday deadline

If the winner hasn't picked by Friday 6 PM UTC, a cron job auto-picks for them so their slot isn't empty. Logged as "XP winner deadline: auto-picked personal GotW".

### Edge cases handled

- First week (no prior snapshot): no winner is selected, regular auto-pick for everyone
- No one gained XP: no winner, regular auto-pick
- Tied XP: tiebreaker is `hours_gained`
- Winner pays off their pick mid-week: personal GotW auto-reroll fires as normal (independent of winner status)
- Winner has no unpaid contracts to pick from: modal shows empty state, they skip the week
- Winner switches profiles or never opens the Ledger: Friday cron auto-picks
- Server-side pick validation: the chosen game must be in their library, unpaid, and not the group GotW

---

## Discord integration

Optional. Configured during setup with a bot token and channel ID. The bot:

- Posts the weekly digest every Wednesday 7 PM UTC
- Can be triggered manually from the debug page ("Post digest now")
- Logs in once on startup (`client.login(token)`) and stays connected

The digest is built as a single embed:
- Group avatar / branding
- Week-over-week stats per user (hours played, contracts settled, XP gained)
- Current Games of the Week with @mentions where the Discord user ID is set
- Highlight of the weekly XP winner

The bot has no commands — it's strictly outbound. If you want command handling, you'd add an `interactionCreate` listener.

---

## Scheduled jobs (cron)

All schedules use UTC.

```
Mon 09:00 → take leaderboard snapshot
Wed 18:30 → auto-sync all Steam libraries
Wed 18:50 → determine weekly XP winner
Wed 18:55 → pick Games of the Week
Wed 19:00 → post Discord digest
Fri 18:00 → XP winner deadline (auto-pick if needed)
```

All jobs are wrapped in try/catch and log to the daily log file. None of them block the HTTP server.

---

## Real-time updates

A lightweight Socket.IO server runs on the same port. The frontend subscribes to a single event channel.

When any user mutates data (sync, manual edit, import, custom game add/delete), the server calls `broadcastLeaderboardUpdate(userId, reason)`. Connected clients receive `leaderboard:update` and call `reload()` silently.

There's no per-user channel — every client sees every update. This is acceptable for a friend group of <20.

---

## Logging

Custom logger writes to:
- `logs/app-YYYY-MM-DD.log` — info, warn, errors
- `logs/errors-YYYY-MM-DD.log` — errors only
- stdout — everything

Log lines are JSON-formatted. Daily rotation (one file per day). Old logs auto-cleaned after 7 days. The debug page reads the most recent 50 lines and any errors from today's file.

There's no log level configuration — `logger.debug()` writes to file at all times. If logs get noisy, grep them.

---

## Front-end architecture

Each HTML page has its own `<script>` block. The shared `public/js/app.js` provides:

- `BL.getProfile()` / `BL.setProfile(id, name)` / `BL.clearProfile()` — cookie-based profile selector
- Helpers for fetch + error handling

There's no router. The current profile is tracked via cookie; the user navigates between pages via `<a href>` links.

### State management

Per-page `state` object — a plain JS object with no observers. After a fetch, the entire UI is re-rendered from the latest state. Performance is fine for <1000 games per profile.

### Real-time updates on the frontend

When `socket.io-client` receives `leaderboard:update`, the page calls `reload()`. The new data overwrites the state object and re-renders.

---

## Backups

There is no automated backup mechanism. The host should periodically copy `backlog.db` (and ideally `config.json`) to a safe place.

To back up while the server is running, SQLite's `.backup` command via `sqlite3 backlog.db ".backup backup.db"` works, but the simplest approach is: stop the server, copy the file, start the server.

The `xp_baseline_backup` table provides limited protection against accidentally deleting a profile — if you recreate a profile with the same Steam ID, baselines are restored. But this doesn't restore games, prices, or imports — only the XP starting points.

---

## Configuration

Two sources:

1. `app_config` table (in DB) — Steam API key, Discord bot token, ITAD API key, admin password hash, group name, setup state
2. `config.json` (on disk) — only stores the HTTP port (default 47821). Created on first run.

Environment variables aren't used because the setup wizard writes everything to the DB on first run.

---

## Common code patterns

### Idempotent database mutations

Many endpoints use `INSERT OR IGNORE` or `INSERT ... ON CONFLICT(...) DO UPDATE`. This makes operations safe to retry without creating duplicates.

### Transactions

Multi-statement writes are wrapped in `db.transaction(() => { ... })()` — this is the better-sqlite3 idiom. Failed transactions roll back automatically.

### Prepared statements

Hot-path queries are prepared once and reused. Example:

```js
const insertGame = db.prepare('INSERT INTO games (app_id, name) VALUES (?, ?) ON CONFLICT...');
for (const g of games) insertGame.run(g.appid, g.name);
```

### Aggregation across Steam accounts

Anywhere we compute stats over a user's games, we first aggregate by `app_id` to merge per-account rows. The pattern is repeated in:
- `GET /api/users/:id/games`
- `computeLeaderboard()`
- `computeUserXpReceipt()`
- `pickGamesOfTheWeek()`
- `POST /api/admin/reroll-group-gotw`
- `POST /api/users/:id/xp-winner-pick` (validation)

If a new endpoint reads from `user_games` and presents derived stats, it should aggregate first. Otherwise multi-account users get inconsistent results.

---

## How to extend

Some pointers for common additions:

### Adding a new endpoint

1. Pick a section in `server.js` (look for the `// ----------` comments)
2. Add the route
3. Use `requireSetup` for normal endpoints, `requireAdmin` for admin-only
4. If it mutates `user_games`, call `broadcastLeaderboardUpdate(userId, 'event_name')` at the end
5. If it touches stats, aggregate by `app_id` across accounts first

### Adding a new column

1. Add it to the relevant `CREATE TABLE` block in `SCHEMA` (for fresh installs)
2. Add an idempotent migration after `db.exec(SCHEMA)`:
   ```js
   const cols = db.prepare("PRAGMA table_info(table_name)").all();
   if (!cols.some(c => c.name === 'new_col')) {
     db.exec('ALTER TABLE table_name ADD COLUMN new_col TYPE DEFAULT ...');
   }
   ```
3. Use the column in your endpoint(s)

### Adding a new scheduled job

Find the cron section at the bottom of `server.js`:
```js
cron.schedule('0 12 * * 1', () => { ... }, { timezone: 'Etc/UTC' });
```
Use `Etc/UTC` for timezone to avoid daylight savings confusion.

### Adding admin UI

The debug page is a single HTML file. Add a `<section class="card">` for your new control, wire up a function in the `<script>` block, and (if needed) add a backend route under `/api/admin/*` with `requireAdmin`.

---

## Known sharp edges

- **No CSRF protection.** Anyone on the network can hit the admin endpoints if they guess the password.
- **No input length limits on most fields.** Display names, labels, notes — all unbounded. The frontend caps some at 50 chars, but the API trusts what's sent.
- **No HTTPS.** Run behind a reverse proxy if you want it.
- **Single admin password.** Can't have per-user admin permissions.
- **No multi-tenancy.** One instance = one friend group. To run multiple groups, run multiple instances on different ports with different DBs.
- **The frontend trusts the server.** XP, leaderboard, GotW are all server-computed. The only client-side calculation is the contract classification, which is non-authoritative (mirrors the server for instant rendering).
- **Steam API key is host-wide.** All profiles share the same key. Steam's rate limits are generous enough that this is fine for ~10 users.

---

## Reading order for new contributors

If you want to learn the codebase, read these sections of `server.js` in order:

1. Schema + migrations (top of file, ~140 lines)
2. `syncSteamAccount` / `syncUserLibrary` (the Steam sync entry points)
3. `GET /api/users/:id/games` (the main read endpoint — shows how aggregation works)
4. `PATCH /api/users/:id/games/:appId` (the main write endpoint — shows GotW auto-reroll)
5. Import endpoints (`/api/users/:id/parse-*` and `/api/users/:id/import-*`)
6. `computeLeaderboard()` and `computeUserXpReceipt()` (XP math)
7. `pickGamesOfTheWeek()` and `determineWeeklyXpWinner()` (weekly mechanics)
8. The cron block at the bottom

Then read the corresponding frontend files for whichever subsystem you're interested in.
