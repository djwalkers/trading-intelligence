# Build 0.7.0 — Real Supabase Schema, Still Local Storage

Date: 2026-07-07
Location: `Trading/platform/web`, `Trading/infrastructure/supabase`
Related: [`BUILD-0.6.0.md`](./BUILD-0.6.0.md),
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../database/SUPABASE-PERSISTENCE-PLAN.md),
[`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md),
[`infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md)

## What was built

Build 0.6.0 planned the Supabase schema in a markdown document. This build makes it real, runnable
SQL — while changing **zero** app behaviour. The app still uses `localStorage` exclusively, still
requires no environment variables, and still makes no network calls to Supabase.

- **Five SQL migration files** in `platform/web/supabase/migrations/`, run in numeric order:
  1. `0001_create_paper_trades.sql` — the core table
  2. `0002_create_trade_intelligence.sql` — 1:1 Market Intelligence extension
  3. `0003_create_trade_events.sql` — append-only open/close audit log
  4. `0004_add_indexes.sql` — indexes on `created_at`, `status`, `source`, `instrument_symbol`,
     and `side`, plus the two extension tables' foreign key columns
  5. `0005_row_level_security.sql` — RLS enabled on all three tables with permissive
     placeholder policies, and a comment block explaining exactly what changes once
     authentication exists
- **`platform/web/supabase/seed.sql`** — sample data: an open Signal trade, an open Market
  Intelligence trade (with its `trade_intelligence` row), a closed trade with realised P/L, and
  `trade_events` rows for every open/close above. For manually verifying the schema in Supabase
  Studio or `psql` — the app does not read this data.
- **`docs/database/SUPABASE-SETUP.md`** — a hands-on guide: create a project, run the migrations
  (SQL Editor or CLI), add environment variables, verify the tables, and an explicit final section
  making clear that none of this turns on app persistence.
- **`infrastructure/supabase/README.md`** — the infrastructure-level pointer: what exists, where,
  and what this environment is *not* yet (no deployed link, no CI, not connected to the app).
- **System Health** now reports "Supabase schema: Prepared" and "Supabase persistence: Disabled"
  explicitly, alongside the existing configured/not-configured environment variable detection
  from Build 0.6.0.

## What did not change

- `getPaperTradeStore()` still always returns `LocalStoragePaperTradeStore`.
- `SupabasePaperTradeStore` is still a placeholder that throws if called — this build did not
  implement it.
- No `@supabase/supabase-js` dependency was added.
- Every existing page, flow, and piece of data (Signals, Market Intelligence, Paper Portfolio,
  Trade Journal, closing trades, filters) behaves exactly as it did in Build 0.6.0.

## Schema overview

Three tables (see `SUPABASE-PERSISTENCE-PLAN.md` for the full field-by-field mapping from the
`PaperTrade` TypeScript type):

| Table | Purpose |
|---|---|
| `paper_trades` | One row per trade — instrument, side, quantity, entry/exit price, status (Open/Closed), source (Signal/Market Intelligence), realised P/L, timestamps |
| `trade_intelligence` | 1:1 extension for Market Intelligence trades — recommendation, evidence (jsonb), evidence factors, invalidation factors |
| `trade_events` | Append-only log of `opened`/`closed` events per trade, with price and timestamp |

Row Level Security is **on** for all three tables, but the policies are explicitly labelled as
prototype-only placeholders (`using (true)`) — there is no `user_id` column yet because there is
no authentication yet. The migration comment documents precisely what to add when auth arrives.

## Fixed while touching this code

The System Health page, sidebar footer, and app footer were still showing "Build 0.6.0" (itself a
fix carried over from a stale "Build 0.1.1" in the previous build) — all three bumped to
"Build 0.7.0". The `SupabasePaperTradeStore` placeholder's error message referenced only the
markdown plan from Build 0.6.0; it now correctly points at the real migration files this build
added.

## What is intentionally not included yet

- No real Supabase connection, client, or queries.
- No `@supabase/supabase-js` dependency.
- No data migration tooling (importing existing `localStorage` trades into Supabase) — still
  planned, not built.
- No deployed/linked Supabase project, and no CI for migrations.
- Everything else unchanged from Build 0.6.0: no authentication, no broker connection, no live
  trading, no AI, no financial advice language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required, and none of the new SQL files are executed by the app or
by `npm run build` — they are plain `.sql` files, only run if you deliberately follow
`docs/database/SUPABASE-SETUP.md` against a real Supabase project. `npm run lint` and
`npm run build` both pass cleanly. Manually verified in this build: the app builds and runs with
no `.env.local` present; existing `localStorage` paper trades still load, save, and close
correctly; and no Supabase network calls are made at any point (there is no client code capable
of making one yet).

## Next recommended build

**Build 0.8.0**: implement `SupabasePaperTradeStore` for real — add `@supabase/supabase-js`, wire
up queries against the now-real `paper_trades`/`trade_intelligence`/`trade_events` tables, add the
one-time `localStorage` import step, and flip `getPaperTradeStore()` to select it when
`isSupabaseConfigured()` is true. Every existing flow was built entirely against the
`PaperTradeStore` interface, so this should require no changes outside the persistence layer
itself.
