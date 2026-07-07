# Supabase Persistence Plan

Status: **planned, not implemented**. This document describes the schema and migration path for
moving paper trades from browser `localStorage` (current, Build 0.6.0) to Supabase (Postgres) in
a future build. Nothing in this document is live — see
[`BUILD-0.6.0.md`](../product/BUILD-0.6.0.md) for what actually shipped.

## Why now, why not yet

Build 0.6.0 introduces a storage-agnostic `PaperTradeStore` interface
(`platform/web/src/lib/persistence/paper-trade-store.ts`) with two implementations:

- `LocalStoragePaperTradeStore` — the active implementation. Used regardless of Supabase
  configuration.
- `SupabasePaperTradeStore` — a placeholder that throws if ever called. It exists so the
  interface has two real implementations to compile against, and so a future build can fill in
  real Supabase queries without changing the interface or any of its callers.

The app never requires Supabase credentials to run, and setting the environment variables below
does **not** switch persistence — it only changes what System Health reports (see
[`BUILD-0.6.0.md`](../product/BUILD-0.6.0.md)).

## Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

See `platform/web/.env.example`. Copy it to `.env.local` (already gitignored) to try this once a
real implementation lands.

## Schema

Three tables, mapping directly onto the existing `PaperTrade` /
`PaperTradeIntelligenceContext` TypeScript types
(`platform/web/src/lib/types/paper-trade.ts`):

- **`paper_trades`** — one row per trade, open or closed. The core record.
- **`trade_intelligence`** — one row per trade **that came from Market Intelligence**. A 1:1
  extension table, not a column bag on `paper_trades`, since most trades (Signal-sourced) will
  never have this data and Postgres handles sparse extension tables more cleanly than a wide
  table full of nulls.
- **`trade_events`** — an append-only audit log of open/close events. Not required by the current
  UI, but cheap to add now and useful the moment partial closes, re-opens, or an activity feed are
  wanted — better to design it in from the start than retrofit it onto an existing table.

```sql
-- Requires pgcrypto (or Supabase's built-in gen_random_uuid()) for UUID generation.

create table paper_trades (
  id uuid primary key default gen_random_uuid(),

  -- The client-generated id already used today (e.g. "trade-sig-001-1783433805852").
  -- Kept as a unique column so existing localStorage trades can be imported without
  -- regenerating ids, and so the client can remain the source of truth for trade identity.
  client_trade_id text not null unique,

  instrument_symbol text not null,
  instrument_name text not null,
  side text not null check (side in ('BUY', 'SELL')),
  quantity numeric not null check (quantity > 0),
  entry_price numeric not null check (entry_price >= 0),

  status text not null check (status in ('Open', 'Closed')),
  source text not null check (source in ('Signal', 'Market Intelligence')),

  strategy_name text not null,
  reason text not null,
  signal_confidence numeric not null check (signal_confidence >= 0 and signal_confidence <= 100),

  -- Present when source = 'Signal' / 'Market Intelligence' respectively. Not a foreign key —
  -- signals and opportunities are mock/generated data today, not rows in another table.
  source_signal_id text,
  source_opportunity_id text,

  -- Populated only when status = 'Closed'.
  exit_price numeric check (exit_price is null or exit_price >= 0),
  closed_at timestamptz,
  realised_pnl numeric,
  realised_pnl_percent numeric,

  opened_at timestamptz not null, -- maps to PaperTrade.timestamp
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index paper_trades_status_idx on paper_trades (status);
create index paper_trades_source_idx on paper_trades (source);

create table trade_intelligence (
  id uuid primary key default gen_random_uuid(),
  paper_trade_id uuid not null references paper_trades (id) on delete cascade,

  recommendation text not null
    check (recommendation in ('Strong Buy', 'Buy', 'Hold', 'Avoid', 'Strong Sell')),

  -- [{ "label": "Trend", "score": 5 }, ...] — mirrors EvidenceRating[]
  evidence jsonb not null,
  evidence_factors text[] not null,
  invalidation_factors text[] not null,

  created_at timestamptz not null default now(),

  unique (paper_trade_id)
);

create table trade_events (
  id uuid primary key default gen_random_uuid(),
  paper_trade_id uuid not null references paper_trades (id) on delete cascade,

  event_type text not null check (event_type in ('opened', 'closed')),
  event_at timestamptz not null default now(),
  price numeric not null, -- entry price for 'opened', exit price for 'closed'
  metadata jsonb
);

create index trade_events_paper_trade_id_idx on trade_events (paper_trade_id);
```

### Field mapping (TypeScript → SQL)

| `PaperTrade` field                        | Column                                    | Notes |
|--------------------------------------------|--------------------------------------------|-------|
| `id`                                       | `paper_trades.client_trade_id`             | Client-generated; `id` (uuid) becomes the real primary key |
| `instrumentSymbol` / `instrumentName`      | `instrument_symbol` / `instrument_name`    | |
| `side`                                      | `side`                                      | |
| `quantity`                                  | `quantity`                                   | |
| `entryPrice`                                | `entry_price`                                | |
| `timestamp`                                 | `opened_at`                                  | |
| `signalConfidence`                          | `signal_confidence`                          | |
| `strategyName`                              | `strategy_name`                              | |
| `status`                                    | `status`                                     | |
| `reason`                                    | `reason`                                     | |
| `source`                                    | `source`                                     | |
| `sourceSignalId`                            | `source_signal_id`                           | nullable |
| `sourceOpportunityId`                        | `source_opportunity_id`                      | nullable |
| `exitPrice`                                 | `exit_price`                                 | nullable |
| `closedAt`                                  | `closed_at`                                  | nullable |
| `realisedPnl`                               | `realised_pnl`                               | nullable |
| `realisedPnlPercent`                        | `realised_pnl_percent`                       | nullable |
| `intelligence.recommendation`               | `trade_intelligence.recommendation`          | 1:1 extension row |
| `intelligence.evidence`                     | `trade_intelligence.evidence` (jsonb)        | |
| `intelligence.evidenceFactors`              | `trade_intelligence.evidence_factors` (text[])| |
| `intelligence.invalidationFactors`          | `trade_intelligence.invalidation_factors` (text[]) | |
| *(implicit: open/close actions)*            | `trade_events` row per action                | not modeled as a TS field; derived |

## Row-level security

Not enabled in this plan — there is no authentication in the app yet (see
[`docs/product/BUILD-0.6.0.md`](../product/BUILD-0.6.0.md) and every prior build doc: "no
authentication" is explicitly out of scope). Enabling RLS without a `user_id` column to key it on
would just add friction with no security benefit. When auth is introduced, add a `user_id uuid
references auth.users` column to `paper_trades` and RLS policies scoping all three tables to
`auth.uid() = user_id` before this schema goes live with real users.

## Migration path (future build)

1. Add `@supabase/supabase-js` as a dependency and implement `SupabasePaperTradeStore.load()` /
   `.save()` against the tables above (batching `trade_intelligence` and `trade_events` writes
   alongside the `paper_trades` upsert).
2. Update `getPaperTradeStore()` to return `SupabasePaperTradeStore` when
   `isSupabaseConfigured()` is true, `LocalStoragePaperTradeStore` otherwise — the one-line change
   this whole abstraction exists to make safe.
3. One-time import: on first load with Supabase configured, read any existing
   `localStorage` trades and upsert them by `client_trade_id`, so nobody loses trade history
   moving over.
4. Only after the above is verified working, consider enabling RLS and requiring auth.
