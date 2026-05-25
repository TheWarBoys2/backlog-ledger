# The Backlog Ledger — Multiplayer Edition

A self-hosted Steam backlog tracker for friend groups. Everyone gets a personal ledger, the group gets a leaderboard, and the machine solemnly demands that every paid game receive at least **1 hour of play per £1 spent**.

The app is designed for a friend group rather than a public website: one person hosts it, everyone else creates/selects their own profile and imports their own Steam data.

**License:** GPL-3.0  
**Status:** In development, but usable for normal play

For internal/technical documentation (data model, request flow, scheduled jobs, design decisions), see `ARCHITECTURE.md`.

---

## What it does

- Syncs each user's Steam library and playtime.
- Tracks paid games as backlog “contracts”: **£1 = 1 hour owed**.
- Splits games into useful ledger sections, including paid-off, outstanding, arrears, free, gifted, and manually completed games.
- Imports Steam purchase history to use the actual amount paid.
- Imports Steam licences to mark **Gift/Guest Pass** and **Complimentary** games as free.
- Uses IsThereAnyDeal to estimate missing prices for games that were not found in purchase history.
- Keeps **Retail/key activations** in the estimate flow, because Steam cannot know whether an external key was bought, bundled, or gifted elsewhere.
- Shows visible price tags such as **EST** and **GIFTED** beneath the game title metadata.
- Provides manual matching for awkward Steam package names in both purchase history and licence imports.
- Lets users remove/ignore licence matches where no match is needed.
- Tracks XP earned from post-baseline backlog progress.
- Includes an **XP Receipt** so users can see exactly where their XP came from.
- Includes a leaderboard, Game of the Week picks, debug/admin tools, and optional Discord digest support.
- Includes an in-app help button with a plain-language setup guide for players.

---

## Quick Start — Host

### 1. Install Node.js

Download and install the **LTS** version of Node.js from `nodejs.org`.

To check it installed correctly, open Command Prompt or PowerShell and run:

```bash
node --version
```

You should see a version number, ideally Node 20 or newer.

### 2. Put the project somewhere sensible

Example:

```text
C:\backlog-ledger\
```

### 3. Install dependencies

Open Command Prompt or PowerShell in the project folder and run:

```bash
npm install
```

### 4. Start the server

```bash
npm start
```

The app will start on:

```text
http://localhost:47821
```

Open that address in your browser.

### 5. Complete first-time setup

The setup wizard asks for:

- group name
- Steam Web API key
- admin password
- optional Discord bot details/webhook details, depending on what you want to use

The setup creates `config.json` and `backlog.db` locally.

### 6. Stop the server

Press:

```bash
Ctrl+C
```

---

## Development mode

While editing the backend, use:

```bash
npm run dev
```

Frontend files in `public/` usually only need a browser refresh.

---

## User setup guide

Each player should do this for their own profile.

### 1. Create or select a profile

Open the app and go to profile selection. Create your profile with:

- display name
- Steam ID, vanity URL, or profile URL
- optional Discord username/ID

### 2. Make Steam game details visible

Steam library syncing only works properly if Steam can see the user's game details.

In Steam, the user should check:

```text
Profile → Edit Profile → Privacy Settings → Game details
```

Set game details to public, or at least visible enough for the host/app to read owned games and playtime.

### 3. Sync Steam library

After the profile is made, sync the library. This imports owned Steam games and current playtime.

The app also has a scheduled weekly sync on Wednesdays at 18:30 UTC.

---

## Profile Tools

Most user-facing imports now live in **Profile tools**.

From the ledger page, use the **Profile tools** button to access:

- combined purchase history + Steam licences/gifts import
- saved import match management
- missing price estimates
- profile details
- profile deletion, with admin password

---

## Importing Steam purchase history, licences, gifts, and complimentary games

Purchase history and Steam licences now use one combined import page. Open **Profile tools → Ledger imports** and paste either source, or paste both at once.

The combined page has two boxes:

1. **Purchase history** — sets the actual amount paid for Steam Store purchases.
2. **Steam licences / gifts** — marks gifted and complimentary/free licence rows as free.

After parsing, both sources go into a single shared matching page, so awkward Steam names only need to be handled in one place.

### Purchase history: how to get it

In Steam, go to:

```text
Account details → View purchase history
```

Copy the purchase history text and paste it into the **Purchase history** box.

### Licences: how to get them

In Steam, go to:

```text
Account details → View licenses and product key activations
```

Or visit:

```text
store.steampowered.com/account/licenses/
```

Copy the licence table and paste it into the **Steam licences / gifts** box.

### What the combined importer does

- Parses Steam purchase rows.
- Parses Steam licence rows.
- Shows purchase rows and free licence rows together on one review page.
- Matches rows to games in the user's library.
- Allows bundle/package matching, where one row covers several games.
- Allows purchase rows to be saved as pending.
- Allows licence rows to be marked as **No match needed**.
- Remembers manual choices, including single-game matches, bundle/package matches, pending purchase rows, and ignored licence rows, so re-importing the same text keeps previous decisions.
- Lets you edit or clear saved import choices later from **Profile tools → Saved import matches**, without re-importing the Steam text.
- Lets real purchase-history prices outrank `Complimentary` licence rows if both sources point at the same game.

### Licence acquisition methods

The licence side only acts on these acquisition methods:

| Steam acquisition method | Ledger result |
|---|---|
| `Gift/Guest Pass` | Mark free, show `GIFTED`, skip price estimation |
| `Complimentary` | Mark free, skip price estimation — unless purchase history has already proven a paid price for the matched game |
| `Retail` | Leave alone; estimate price normally |
| `Steam Store` | Leave alone; purchase history handles this |

### Matching options

The shared review page supports:

- match a row to one game
- match a bundle/package row to multiple games
- change an existing match
- save purchase rows as pending
- remove/ignore licence matches where no match is needed
- restore an ignored licence row if you made a mistake

Ignored/no-match-needed licence rows are skipped during import and do not mark anything free. These ignored decisions are remembered for the next import.

---

## Missing price estimates

After purchase history and licence imports, some games may still have no price.

Use **Profile tools → Missing price estimates** to fill those in.

The estimator is intended for:

- Retail keys
- Humble/Fanatical/other bundle keys where exact purchase price is unknown
- old games with no clean Steam purchase row
- manually imported/external library oddities

The estimator should not override gifted or complimentary games once the licence import has marked them free.

---

## Ledger rules

The core rule is:

```text
£1 spent = 1 hour owed
```

Examples:

| Paid price | Hours needed |
|---:|---:|
| £5.00 | 5 hours |
| £12.49 | 12.49 hours |
| £0.00 | Free, no contract |

Common tags:

| Tag | Meaning |
|---|---|
| `EST` | Price was estimated rather than imported from actual purchase history |
| `GIFTED` | Steam licence import found a Gift/Guest Pass row |

Gifted and complimentary games live in the free section.

Retail keys are **not** automatically free. They remain paid/estimated unless manually corrected, because Steam only knows that a key was activated, not whether the user paid for it.

---

## XP system

XP is calculated from playtime gained after the user's XP baseline is created.

Rules:

- XP only comes from paid backlog contracts.
- Free, gifted, complimentary, exempt, and already-settled games do not generate XP.
- The baseline is the playtime at the point XP tracking started.
- Only hours played while the game is still under its paid threshold count.
- Base rate is **1 XP per counted hour**.
- Game of the Week progress receives a bonus multiplier.

Each ledger has an **XP earned** card with a **View receipt** button. The receipt shows:

- total XP
- contract XP
- Game of the Week bonus XP
- each game that contributed XP
- baseline hours
- current hours
- counted hours
- base XP
- bonus XP
- final XP per game

There is also a permanent global **Recalculate XP** button for refreshing XP calculations after sync/import changes.

---

## Leaderboard and Game of the Week

The leaderboard compares players across the group and includes backlog stats such as:

- total games
- total spend
- total hours
- debt/outstanding backlog
- settlement rate
- XP
- Game of the Week progress

Admin/debug tools can pick or reroll Game of the Week selections.

---

## Admin and debug tools

The debug page is protected by the admin password and includes tools for:

- viewing server/debug information
- checking logs/errors
- testing IsThereAnyDeal configuration
- setting the IsThereAnyDeal API key
- posting Discord digest
- taking snapshots
- picking/rerolling Game of the Week
- setting a specific user's personal Game of the Week

---

## Discord digest

The server includes Discord support for a group digest. Exact behaviour depends on your setup configuration, but the debug/admin page includes a manual post action.

Scheduled digest/sync behaviour may need adjusting depending on how the group wants to play.

---

## Changing the port

Default port is:

```text
47821
```

To change it, edit `config.json` after first setup:

```json
{ "port": 12345 }
```

Then restart the server.

---

## Files and folders

```text
backlog-ledger/
├── server.js                 Backend, API routes, database logic, sync, XP, imports
├── package.json              Node dependencies and scripts
├── config.json               Local config, created by setup
├── backlog.db                SQLite database, created automatically
├── public/
│   ├── index.html            Main ledger
│   ├── profiles.html         Profile selection/creation
│   ├── profile-edit.html     Profile tools and settings
│   ├── import.html           Steam purchase history import
│   ├── import-licenses.html  Redirects to combined import
│   ├── leaderboard.html      Group leaderboard
│   ├── setup.html            First-time setup wizard
│   ├── debug.html            Admin/debug tools
│   ├── library.html          Library tools/view
│   ├── style.css             Shared styling
│   └── js/app.js             Shared frontend helpers/help button
└── README.md
```

---

## Backups

Before making big changes, back up:

```text
backlog.db
config.json
```

The database contains profiles, games, imports, match overrides, baselines, XP-related records, and ledger state.

---

## Notes and known quirks

- Steam library names and Steam purchase/licence names often do not match perfectly. Use manual matching when needed.
- Retail/key activations cannot reliably reveal what the user paid. That is why the app estimates them unless manually corrected.
- A Humble key gifted by a friend may still appear as `Retail`; Steam cannot know it was a gift.
- Gifted Steam copies usually appear as `Gift/Guest Pass` in the licences page and can be marked free by the combined import.
- Complimentary/free promotional packages often have awkward names, so manual matching may be needed.
- If a row truly does not need to match anything, use **No match needed**.

