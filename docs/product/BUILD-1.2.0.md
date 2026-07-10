# Build 1.2.0 — Password Reset & Provider-Backed Trade Entry Pricing

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`BUILD-1.0.0.md`](./BUILD-1.0.0.md), [`BUILD-1.1.0.md`](./BUILD-1.1.0.md),
[`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md)

## What was built

Two mostly-independent improvements: a full password reset flow for Supabase Auth, and closing
the last gap in Build 1.0.0's market data work — trade **entry** prices now come from
`MarketDataProvider` too, not just ongoing valuation.

- **Password reset.** "Forgot password?" on the sign-in form links to a new `/forgot-password`
  page (email → `resetPasswordForEmail`, generic "check your inbox" message regardless of whether
  the address is registered). The emailed link lands on a new `/reset-password` page, which relies
  on Supabase's client automatically establishing a temporary recovery session from the URL; if
  there's no session (invalid, already used, or expired link), the page says so and points back to
  `/forgot-password` instead of showing a broken form. Both pages use the same minimal centered
  auth layout as sign-in/sign-up.
- **Trade entry pricing via MarketDataProvider.** Placing a trade from Signals or Market
  Intelligence now fetches a live quote for that instrument at the moment "Paper Trade" is clicked,
  the same way `useCloseTradeFlow` already fetched a live quote at close (Build 1.0.0). The
  confirmation modal opens immediately and shows "Fetching current price…" / "Calculating…" for
  price and quantity (quantity depends on price) until the quote resolves; Confirm is disabled
  until it does.
- **Entry price provenance shown and stored.** The modal now shows a Price source badge
  (Mock/External + provider name), a "Price last updated" timestamp, and — if the market data
  provider had fallen back to mock for this quote — an amber note saying so. This provenance
  (`entryPriceSource`, `entryPriceProvider`, `entryPriceTimestamp`) is stored on the resulting
  `PaperTrade`, all three fields optional so every trade placed before this build (which has none
  of them) continues to load and display exactly as before.
- **System Health reviewed for accuracy** — Authentication, Persistence, and Market Data panels
  all still read live state correctly; build label bumped throughout.

## Type/model changes

`PaperTrade` (`src/lib/types/paper-trade.ts`) gains three optional fields:

```ts
entryPriceSource?: MarketDataSource;   // "Mock" | "External"
entryPriceProvider?: string;           // e.g. "Mock" or "Finnhub"
entryPriceTimestamp?: string;          // ISO timestamp of the quote, not of the trade itself
```

New `EntryPriceInfo` interface (same file) bundles a resolved quote with its mode
(`Connected`/`Mocked`/`Fallback`) — the shape both `buildPaperTradeFromSignal` and
`buildPaperTradeFromOpportunity` now require as a second parameter, instead of each computing
`entryPrice` internally from the static mock instrument (as they did through Build 1.1.0).

**Why a parameter instead of an internal lookup:** identical reasoning to Build 1.0.0's
`calculatePaperTradePerformance` refactor — a function that sources its own price can't be async,
and a live quote fetch is inherently async. `usePaperTradeEntryFlow` (new,
`src/lib/state/use-paper-trade-entry-flow.ts`) is the one place that owns the fetch; the builders
stay pure functions of the data they're given.

## Files changed

New:
- `src/lib/state/use-paper-trade-entry-flow.ts` — shared request/resolve/confirm flow, generic
  over the source object (`Signal` or `Opportunity`)
- `src/app/forgot-password/page.tsx`, `src/app/reset-password/page.tsx`
- `supabase/migrations/0008_add_entry_price_provenance.sql`

Changed:
- `src/lib/types/paper-trade.ts` — `EntryPriceInfo`, three new optional `PaperTrade` fields
- `src/lib/utils/paper-trade.ts` — `buildPaperTradeFromSignal`/`buildPaperTradeFromOpportunity`
  take `EntryPriceInfo`; `quantityForEntryPrice` and `sideForRecommendation` exported (components
  need them to compute quantity/side while a quote is still loading);
  `MARKET_INTELLIGENCE_MODEL_NAME` exported
- `src/components/trading/PaperTradeModal.tsx` — nullable `quantity`/`entryPriceInfo`,
  `isPriceLoading`, price source badge, last-updated row, fallback note, Confirm disabled until
  ready
- `src/components/tables/SignalsTable.tsx`,
  `src/components/market-intelligence/MarketIntelligenceView.tsx` — use
  `usePaperTradeEntryFlow` instead of building a `PaperTrade` synchronously on click
- `src/lib/auth/auth-context.tsx` — `requestPasswordReset`, `updatePassword`
- `src/components/auth/AuthForm.tsx` — "Forgot password?" link (sign-in mode only)
- `src/components/layout/AppShell.tsx` — `/forgot-password` and `/reset-password` added to the
  minimal-layout route set
- `src/lib/persistence/supabase-paper-trade-store.ts` — maps the three new columns both ways
- `src/app/system-health/page.tsx`, `src/components/layout/Sidebar.tsx`,
  `src/components/layout/Footer.tsx` — build label bumped to 1.2.0

## Database changes

**`0008_add_entry_price_provenance.sql`** — adds `entry_price_source` (text, checked against
`'Mock'`/`'External'`), `entry_price_provider` (text), `entry_price_timestamp` (timestamptz) to
`paper_trades`. All nullable and purely informational — never read by any P/L calculation, so
skipping this migration doesn't break anything; the app just won't persist (or, for a session that
falls back to local storage, won't need) this provenance server-side.

No changes were needed for password reset — Supabase Auth's recovery flow uses `auth.users` and
Supabase-managed tokens, not any table in this schema.

## Manual Supabase steps required

Run `0008_add_entry_price_provenance.sql` in the SQL Editor (same anon-key limitation as every
prior schema change in this project — the app cannot run DDL itself). Until it's applied, placing
a trade while signed in against Supabase will fail on insert (unknown column) and the resilient
store will treat it as a generic failure, falling back to local storage for the rest of that
session — not data loss, but not the intended behaviour either.

**A schema discovery made during this build's testing:** migrations `0006` and `0007` from Build
1.1.0 — `user_id` and user-scoped RLS — **have since been applied to the connected project**
(confirmed two ways: the `user_id` column now exists, and an unauthenticated insert attempt was
genuinely rejected with `new row violates row-level security policy`, not silently accepted). This
happened between builds, outside this session. `0008` is additive on top of that and does not
require redoing 0006/0007.

## What is intentionally not included yet

- OAuth providers, magic links — password reset is email/password only, matching the existing
  sign-up/sign-in scope
- Forcing re-authentication after a password reset (the Supabase recovery session is used as-is to
  redirect straight to the Dashboard, rather than signing the user out and requiring a fresh
  sign-in with the new password)
- Entry price provenance for Signal/Market Intelligence trades placed against a Supabase project
  where migration 0008 hasn't been run (falls back to local storage for that session instead, per
  the existing resilient-store behaviour)
- Symmetric provenance for exit/close prices — `useCloseTradeFlow` still just returns a bare
  number; only entry pricing was in scope for this build
- No broker execution, no live order placement, no AI, no "Hermes" — exactly as instructed

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

**Verified in this build:**
- Sign-in page renders with the new "Forgot password?" link; `/forgot-password` renders, accepts
  an email, and submits successfully against the real connected Supabase project, showing the
  generic "check your inbox" confirmation (no error either revealing or denying account
  existence).
- `/reset-password` correctly detects it has no valid recovery session (visited directly, without
  a real reset link) and shows "This password reset link is invalid or has expired" rather than a
  broken form.
- In local prototype mode: placing a trade from Signals and from Market Intelligence both fetch a
  live entry quote and show it in the modal (instrument, price, quantity computed from that price,
  Price source "Mock · Mock", a real last-updated timestamp); confirming persists all three new
  fields correctly (`entryPriceSource`, `entryPriceProvider`, `entryPriceTimestamp`) into
  `localStorage`; closing a trade still works and shows the correct estimated P/L; Portfolio values
  both new trades and a manually-injected pre-1.2.0 trade (missing all three new fields) correctly,
  with no console errors — confirming backward compatibility directly, not just by type-checking.
- Confirmed live against the real Supabase project that migrations `0006`/`0007` are genuinely
  active (see Manual Supabase steps above).

**Not verified live against Supabase in this environment:** the project's Supabase Auth still
requires email confirmation, and no inbox was available to confirm a test account (same limitation
disclosed in Build 1.1.0) — so signing in, placing a trade, and having it persist with `user_id`
*and* the new entry-price-provenance columns together was not exercised end-to-end against a real
authenticated session. Migration `0008` also has not yet been applied to the live project. Anyone
adopting this should run `0008`, confirm a real test account by email, and verify an authenticated
trade round-trips with all its provenance fields before relying on it.

## Suggested Build 1.3.0

With entry and ongoing valuation both now sourced from `MarketDataProvider`, and Auth essentially
complete for a prototype (sign-up, sign-in, sign-out, password reset), the most valuable next step
is the verification pass repeatedly deferred since Build 1.1.0 — run migrations 0006–0008 (or
confirm they're current), confirm one real test account, and exercise the full authenticated
lifecycle (sign in, place a trade with live entry pricing, close it, sign out, sign back in and see
only your own trades) end to end. Beyond that: symmetric price provenance on the close/exit side,
and reconsidering whether a password reset should force re-authentication rather than signing the
user straight in.
