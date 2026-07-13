-- Phase 2A — Market Universe Foundation
--
-- Builds and verifies a dynamically maintained, eligible US trading universe (NASDAQ, NYSE, NYSE
-- American), sourced from NASDAQ Trader's official, free symbol directory files
-- (nasdaqlisted.txt/otherlisted.txt) — no manually maintained list. One row per real security ever
-- seen; rows are never deleted, only marked is_active = false on delisting, so the universe's
-- history survives a symbol coming and going. See docs/product/PHASE-2A-MARKET-UNIVERSE.md for the
-- full architecture, data source, and filtering rules.
--
-- Scope note: this table is built and verified standalone in Phase 2A. No function in this phase
-- converts a row here into a Strategy-Engine-shaped Instrument — the worker's traded instrument
-- list remains the existing static 5-symbol list unconditionally (see src/worker/process-schedule.ts)
-- until Phase 2B provides a bounded shortlist and a volume-capable price data source.
--
-- Unlike every other table in this app, this is global market-reference data, not per-user data —
-- there is no user_id column and no auth.uid() = user_id policy here (see the RLS note below).

create table if not exists market_universe_symbols (
  -- The source-stable symbol itself, not a synthetic uuid — simplifies every upsert/diff query to
  -- `on conflict (symbol)` and matches how every other part of this app already keys an instrument.
  symbol text primary key,

  company_name text not null,
  exchange text not null check (exchange in ('NASDAQ', 'NYSE', 'NYSE American')),

  -- Correctly identified, but only "unsupported" is ever excluded on instrument-type grounds —
  -- ETFs/ADRs/REITs remain ordinarily-tradeable, eligible instrument types (see is_eligible below).
  instrument_type text not null check (
    instrument_type in ('equity', 'etf', 'adr', 'reit', 'unsupported')
  ),
  -- Data lineage for instrument_type: 'source_flag' means it came from a real field NASDAQ
  -- Trader's files provide directly (only ever true for ETF, via is_etf below); 'name_pattern_inferred'
  -- means it was derived from a company-name regex, since the source has no real ADR/REIT column at
  -- all. Never treat a name_pattern_inferred classification as authoritative — live verification
  -- during this phase found most real REIT companies' listed names do not contain the word "REIT"
  -- at all (e.g. Realty Income Corporation), so REIT detection specifically has a high, documented
  -- false-negative rate. See classify-instrument.ts and the phase doc's "Known limitations".
  classification_method text not null check (
    classification_method in ('source_flag', 'name_pattern_inferred')
  ),
  is_etf boolean not null default false,
  is_test_issue boolean not null default false,

  -- True for every symbol present in the most recent successful refresh's downloaded snapshot;
  -- flipped to false (never deleted) the moment a refresh no longer sees a previously-active symbol.
  is_active boolean not null default true,

  -- Deliberately separate from exclusion_reason below: a symbol awaiting its first price check is
  -- not "ordinarily excluded" (a settled business-rule decision), it is "not yet knowable" (a
  -- temporary, converging state). See price-eligibility.ts for the capped/incremental batch design
  -- and the real convergence math (~5 days for a first full pass at PRICE_CHECK_BATCH_SIZE=1750).
  price_assessment_status text not null default 'awaiting_check' check (
    price_assessment_status in ('awaiting_check', 'checked')
  ),
  -- Populated by the incremental, rate-limited price-check pass — null until checked at least
  -- once. A symbol is never guessed eligible before this is populated (price_assessment_status
  -- stays 'awaiting_check' until it is).
  last_price numeric,
  last_price_checked_at timestamptz,
  -- Real, from the same Finnhub /quote response as last_price, at no extra API cost — never
  -- fabricated as 0 when a field is genuinely absent. Finnhub's basic quote endpoint has no volume
  -- field at all, so there is deliberately no last_volume column in Phase 2A — see
  -- get-market-universe-summary.ts and the phase doc's "Known limitations".
  last_change_absolute numeric,
  last_change_percent numeric,
  last_day_high numeric,
  last_day_low numeric,
  -- Data lineage for the price-check fields above (e.g. 'Finnhub') — null until first checked.
  price_provider text,

  -- Phase 2A stage-1 eligibility only (price floor, active listing, supported instrument type) —
  -- always a persisted column, recomputed on every relevant write, never recomputed on read, so the
  -- worker's hot-path query can never disagree with what the refresh job just computed. Liquidity
  -- filtering is explicitly out of scope — see "Recommended Phase 2B".
  is_eligible boolean not null default false,
  -- Settled, genuine business-rule exclusions only — does NOT include "not yet price-checked" (see
  -- price_assessment_status above), so this column never conflates "we know this symbol doesn't
  -- qualify" with "we don't know yet."
  exclusion_reason text check (
    exclusion_reason is null
    or exclusion_reason in ('test_issue', 'unsupported_instrument_type', 'price_below_minimum', 'delisted')
  ),

  -- Listing-lineage fields — which official file this row came from, and when it was fetched.
  data_source text not null default 'NasdaqTrader',
  source_timestamp timestamptz not null,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  delisted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The worker's hot read path (get-eligible-universe-rows) — a partial index, since is_eligible is
-- only ever true for a fraction of the universe.
create index if not exists market_universe_symbols_eligible_idx
  on market_universe_symbols (is_eligible)
  where is_eligible = true;

-- The incremental price-check batch-selection query (select-price-check-batch) — never-checked
-- symbols first, then the longest-stale checked ones, both scoped to symbols with no listing-level
-- exclusion (never worth an API call on a symbol already known ineligible for a listing reason).
create index if not exists market_universe_symbols_price_check_idx
  on market_universe_symbols (exclusion_reason, price_assessment_status, first_seen_at, last_price_checked_at);

-- Global, shared market-reference data, not per-user data — auth.uid() = user_id (every other
-- table's RLS pattern) doesn't apply here. Nothing in this phase reads this table except the
-- service-role worker and the standalone refresh CLI (both bypass RLS entirely) — there is no new
-- UI and no browser reader yet, so the tightest correct default today is RLS enabled with zero
-- policies (default-deny), not "any authenticated SELECT." Trivial to add a SELECT policy later if
-- a diagnostics UI is ever built.
alter table market_universe_symbols enable row level security;

comment on table market_universe_symbols is
  'Phase 2A. The eligible US trading universe (NASDAQ/NYSE/NYSE American), sourced from NASDAQ Trader''s official symbol directory files. Built and verified standalone in this phase — not yet consumed by the worker''s trading path. Global market-reference data, not per-user — access is service-role-only by design for this phase (RLS enabled, no policies).';
comment on column market_universe_symbols.instrument_type is
  'Derived from the real company name (and the source''s own real ETF flag) via a deterministic pattern classifier — see classification_method for whether a given row''s value is source-sourced or inferred.';
comment on column market_universe_symbols.classification_method is
  'Data lineage: source_flag (real, from NASDAQ Trader''s own ETF column) or name_pattern_inferred (derived from the company name; treat as best-effort, not authoritative — see the documented REIT false-negative finding).';
comment on column market_universe_symbols.price_assessment_status is
  'awaiting_check until a live price has been successfully fetched at least once; distinct from exclusion_reason, which is only ever a settled business-rule exclusion.';
comment on column market_universe_symbols.is_eligible is
  'Phase 2A stage-1 eligibility only: active, not a test issue, a supported instrument type, price_assessment_status = checked, and price >= $1. Liquidity filtering is Phase 2B.';
comment on column market_universe_symbols.last_price is
  'The last live-quote price checked for this symbol (Finnhub) — null until checked at least once. Checked incrementally across refresh runs, not necessarily every run.';
comment on column market_universe_symbols.price_provider is
  'Data lineage for the price-check fields (last_price/last_change_*/last_day_*): which provider supplied them (e.g. Finnhub). Null until first checked.';
