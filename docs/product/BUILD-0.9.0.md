# Build 0.9.0 — Real Supabase Persistence

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`BUILD-0.7.0.md`](./BUILD-0.7.0.md), [`BUILD-0.8.0.md`](./BUILD-0.8.0.md),
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../database/SUPABASE-PERSISTENCE-PLAN.md),
[`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md)

## What was built

`SupabasePaperTradeStore` is no longer a placeholder — it's a real implementation against the
schema from Build 0.7.0, using `@supabase/supabase-js`. **Nothing changes visually for anyone not
using Supabase.** `localStorage` remains fully supported and is still what runs by default with
zero configuration.

- **Real `SupabasePaperTradeStore`.** Implements `load`, `addTrade`, and `closeTrade` against
  `paper_trades`, `trade_intelligence`, and `trade_events` — the exact schema created in Build
  0.7.0, unchanged. Opening a trade inserts a `paper_trades` row (plus a `trade_intelligence` row
  when the trade carries Market Intelligence metadata) and a `trade_events` row of type
  `'opened'`. Closing a trade updates the `paper_trades` row and appends a `trade_events` row of
  type `'closed'`. Every field the UI already relies on — source, recommendation, evidence,
  confidence, realised P/L — round-trips through Supabase exactly as it does through
  `localStorage` today.
- **Store selection.** `getPaperTradeStore()` now genuinely chooses: Supabase when
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are both set, local storage
  otherwise. No UI changes required to use either — the same components, same modals, same pages.
- **Resilient fallback.** A new `ResilientPaperTradeStore` wraps whichever store is active. If a
  Supabase call ever throws, it logs the reason, switches to local storage for the rest of the
  session (no repeated retries against a connection already known to be broken), and retries the
  same operation against local storage so the user's action still succeeds. A slim banner —
  "Persistence unavailable. Falling back to local storage." — appears app-wide only when this has
  happened; it is invisible in every other case.
- **First-run import.** When Supabase is the active store, has no trades of its own, there's
  existing `localStorage` history, and the user hasn't already answered this once before, a modal
  offers "Import existing paper trading history?" with Import / Skip. Skipping or importing both
  mark the prompt resolved (via a `localStorage` flag) so it is never shown again on that browser.
- **System Health, made live.** The static "Persistence Mode" / "Supabase" mock rows are replaced
  with a real `PersistenceStatusPanel` reading live state: Current mode (Local Browser Storage /
  Supabase), Connection (Connected / Disconnected, with the fallback reason shown if applicable),
  and Last Synchronisation (timestamp of the most recent successful read or write).
- **Performance.** The store is a module-level singleton — one instance, one connection, shared
  by every component via `getPaperTradeStore()`. Trades are loaded once on mount; nothing polls.
  Once a session has fallen back, it does not attempt the primary store again.
- **Security.** Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are read, and
  read only client-side. No service role key is used or referenced anywhere in the app; access
  control is delegated entirely to the RLS policies already in `0005_row_level_security.sql`.

## Architecture changes

- **`PaperTradeStore` interface redesigned**: the old single `save(trades: PaperTrade[])` method
  (write the whole array every time) is replaced with granular `addTrade(trade)` and
  `closeTrade(trade)`. A generic "save everything" method cannot express "insert one row and
  append an event" without re-diffing the entire array on every change — the interface needed to
  change for Supabase to be implementable correctly, not just technically compilable against.
  `LocalStoragePaperTradeStore` was updated to match; its on-disk format and behaviour are
  unchanged.
- **`PaperTradesContext.updateTrade` renamed to `closeTrade`.** It was already only ever called
  from the close-trade flow — the rename makes that explicit at the type level and lets the
  Supabase store know precisely when to append a `'closed'` event, rather than inferring intent
  from a generic update.
- **New `ResilientPaperTradeStore`** (`src/lib/persistence/resilient-paper-trade-store.ts`) owns
  the fallback behaviour and a small internal pub-sub of `PersistenceStatus`
  (`{ mode, connected, lastSyncedAt, fallbackReason }`), consumed via a new
  `usePersistenceStatus()` hook.

## Files changed

- `src/lib/persistence/paper-trade-store.ts` — interface redesign
- `src/lib/persistence/local-storage-paper-trade-store.ts` — updated to the new interface
- `src/lib/persistence/supabase-paper-trade-store.ts` — real implementation (was a placeholder)
- `src/lib/persistence/resilient-paper-trade-store.ts` — new
- `src/lib/persistence/persistence-status.ts` — new (`PersistenceStatus` type)
- `src/lib/persistence/get-paper-trade-store.ts` — now constructs Supabase + resilient wrapper
- `src/lib/state/paper-trades-context.tsx` — `updateTrade` → `closeTrade`; first-run import state
- `src/lib/state/use-close-trade-flow.ts` — updated for the rename
- `src/lib/state/use-persistence-status.ts` — new hook
- `src/components/system-health/PersistenceStatusPanel.tsx` — new, live System Health widget
- `src/components/layout/PersistenceFallbackBanner.tsx` — new, app-wide fallback banner
- `src/components/trading/ImportHistoryModal.tsx` — new, first-run import prompt
- `src/components/layout/AppShell.tsx` — mounts the new banner and modal
- `src/app/system-health/page.tsx` — renders `PersistenceStatusPanel`; build label bumped
- `src/lib/mock/system-health.ts` — removed the now-superseded static persistence mock rows
- `package.json` — added `@supabase/supabase-js`

## Migration notes

- **No database migration is required** — the schema from Build 0.7.0 is used as-is, exactly per
  the brief ("do not redesign the database").
- **Existing `localStorage` users are unaffected** by default and need to do nothing.
- **Adopting Supabase**: follow the updated `docs/database/SUPABASE-SETUP.md` — create a project,
  run the five migrations, add the two environment variables to `.env.local`. On first load with
  existing local history and an empty Supabase project, the import prompt handles moving that
  history over; there is no separate CLI migration step.
- **Rollback**: removing the two environment variables (or letting Supabase become unreachable)
  is non-destructive — `localStorage` still holds every trade that was ever saved there, and the
  app falls back to it automatically.

## What is intentionally not included yet

- No authentication — RLS policies remain the permissive placeholders from Build 0.7.0.
- No real-time sync / multi-tab updates from Supabase — data is loaded once per page load.
- No retry/reconnect attempt within a session after falling back — a fresh page load is required
  to try Supabase again. This is deliberate ("do not fetch repeatedly").
- No UI to manually trigger a re-import or re-sync.
- Everything else unchanged from Build 0.8.0: no broker connection, no live trading, no AI, no
  financial advice language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. To try Supabase: follow
`docs/database/SUPABASE-SETUP.md`, then copy `.env.example` to `.env.local` and fill in your
project's URL and anon key.

`npm run lint` and `npm run build` both pass cleanly. Manually verified in this build: the app
builds and runs correctly with no `.env.local` present; the full paper trading lifecycle (Signal
trade, Market Intelligence trade, closing a trade) works end-to-end against local storage exactly
as before; and — using a syntactically valid but unreachable Supabase URL to simulate an outage —
the app does not crash, logs `[persistence] Supabase unavailable, falling back to local storage`
with the underlying error, shows the "Persistence unavailable" banner, correctly updates System
Health to Local Browser Storage / Connected / Disconnected-reason-shown, and continues accepting
new trades via the local fallback throughout. **Not verified against a real, reachable Supabase
project** — no live project was available in this environment, so the "successfully connected"
and "import into a working project" code paths are implemented and reviewed but not live-tested
end-to-end. Anyone adopting this should verify those two paths against their own project before
relying on them.

## Next recommended build

**Build 1.0.0**: the first non-prototype milestone. With real persistence now implemented (even
if not yet live-verified against a production Supabase project), the natural next step is
authentication — add real user accounts, a `user_id` column on `paper_trades`, and replace the
permissive RLS placeholder policies with real `auth.uid() = user_id` scoping, so paper trading
history is actually private per user rather than shared across anyone using the same project.
