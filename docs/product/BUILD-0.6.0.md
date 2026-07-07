# Build 0.6.0 — Supabase-Ready Persistence

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md), [`BUILD-0.1.1.md`](./BUILD-0.1.1.md),
[`BUILD-0.2.0.md`](./BUILD-0.2.0.md), [`BUILD-0.3.0.md`](./BUILD-0.3.0.md),
[`BUILD-0.4.0.md`](./BUILD-0.4.0.md), [`BUILD-0.5.0.md`](./BUILD-0.5.0.md),
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../database/SUPABASE-PERSISTENCE-PLAN.md)

## What was built

This build does not add a database — it prepares the codebase so a future build can add one
without disruption. **The app still requires zero configuration to run**, and behaves identically
to Build 0.5.0 for every existing feature.

- **A persistence abstraction for paper trades.** A new `PaperTradeStore` interface
  (`src/lib/persistence/paper-trade-store.ts`) with two implementations:
  - `LocalStoragePaperTradeStore` — the code that used to live directly inside
    `PaperTradesProvider`, extracted as-is (same storage key, same legacy-record
    normalization, same behaviour).
  - `SupabasePaperTradeStore` — a placeholder that throws a clear "not implemented yet" error if
    ever called. It exists purely so the interface has two real implementations to compile
    against.
  - `getPaperTradeStore()` — a factory that **always returns the local storage implementation**
    in this build, regardless of Supabase configuration. Switching this one function is the only
    change a future build needs to make to go live with Supabase.
- **`PaperTradesProvider` now goes through the store abstraction** instead of calling
  `window.localStorage` directly. Behaviour is unchanged; only where the storage logic lives has
  changed.
- **System Health shows persistence status.** Two new entries: "Persistence Mode" (always "Local
  Browser Storage" right now) and "Supabase" ("Not configured", or "Configured" — with an
  explicit note that live persistence isn't implemented yet — when
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are both present).
  `isSupabaseConfigured()` (`src/lib/persistence/config.ts`) is purely informational — it never
  changes which store is active.
- **`.env.example`** documents the two Supabase environment variables as optional, with a note
  that setting them does not change app behaviour yet.
- **Schema plan.** [`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../database/SUPABASE-PERSISTENCE-PLAN.md)
  defines three tables — `paper_trades`, `trade_intelligence`, `trade_events` — with a full
  field-by-field mapping from the existing `PaperTrade` TypeScript type, RLS notes, and a
  concrete migration path for a future build. No `@supabase/supabase-js` dependency was added —
  there's no real client code yet to need it.

## Why a placeholder store instead of a real one

A half-working Supabase integration would be worse than none: if `getPaperTradeStore()` switched
to `SupabasePaperTradeStore` the moment someone set the environment variables, and that store
isn't actually implemented, anyone who adds credentials early (e.g. while testing deployment
config) would silently lose paper trade persistence. Keeping the factory hardcoded to local
storage — with Supabase-configured status surfaced only as an informational System Health row —
means there is no way to accidentally break persistence in this build.

## What is intentionally not included yet

- No real Supabase connection, client, or queries — `SupabasePaperTradeStore` throws if called
  and is never selected.
- No `@supabase/supabase-js` dependency.
- No authentication, and therefore no row-level security on the planned schema (documented as a
  prerequisite for going live in `SUPABASE-PERSISTENCE-PLAN.md`).
- No data migration tooling yet (planned, not built — see that document's migration path).
- Everything else unchanged from Build 0.5.0: no broker connection, no live trading, no AI, no
  financial advice language.

## Fixed while touching this code

The System Health page had two stale leftovers from Build 0.1.1 that no later build had updated:
the page description and badge both still hardcoded "Build 0.1.1", and the services count
("Six core services...") was a hardcoded string rather than derived from the actual list. While
fixing that, the same stale "Build 0.1.1" text was found in the sidebar footer and the app-wide
footer component too — both updated to "Build 0.6.0" as well.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. Optionally copy `.env.example` to `.env.local` and fill in
Supabase values to see System Health report "Supabase: Configured" — persistence still uses local
storage either way. `npm run lint` and `npm run build` both pass cleanly. Manually verified in
this build: a hand-seeded pre-existing localStorage trade still loads correctly through the new
store abstraction; new trades from both Signals and Market Intelligence still save and close
correctly; the app runs with no `.env.local` present at all; and every route still returns 200.

## Next recommended build

**Build 0.7.0**: implement `SupabasePaperTradeStore` for real against the schema in
`SUPABASE-PERSISTENCE-PLAN.md` — add `@supabase/supabase-js`, wire up
`paper_trades`/`trade_intelligence`/`trade_events` queries, add the one-time localStorage import
step, and flip `getPaperTradeStore()` to select it when `isSupabaseConfigured()` is true. Trade
closing and every other existing flow should need no changes, since they were built entirely
against the `PaperTradeStore` interface, not against `localStorage` directly.
