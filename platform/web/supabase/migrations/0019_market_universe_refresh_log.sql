-- Phase 2A — Market Universe Foundation
--
-- One row per Market Universe refresh run (npm run refresh-universe) — the durable record behind
-- "provide operational evidence: total symbols downloaded, eligible symbols, excluded symbols,
-- exclusion reasons, refresh duration, data source, last refresh time." Diagnostics only, per the
-- phase spec — no dashboard reads this yet; reading the latest row directly, or the refresh CLI's
-- own printed summary, is the diagnostic. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
--
-- Also the source of truth for the observability summary's fail-safe contract: a row with
-- status = 'completed' must exist before get-market-universe-summary.ts will report anything (see
-- hasCompletedRefreshRun) — distinct from "refreshed, but nothing currently qualifies," which is a
-- legitimate, different state (see eligible_count/awaiting_price_check_count below).

create table if not exists market_universe_refresh_log (
  id uuid primary key default gen_random_uuid(),

  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,

  data_source text not null default 'NasdaqTrader',

  total_downloaded integer,
  new_listings_count integer,
  delistings_count integer,
  metadata_changes_count integer,

  price_checks_performed integer,
  price_check_failures integer,

  eligible_count integer,
  -- Settled, genuine business-rule exclusions only (test_issue, unsupported_instrument_type,
  -- price_below_minimum, delisted) — separate from awaiting_price_check_count below, so "excluded"
  -- never conflates "we know this symbol doesn't qualify" with "we don't know yet."
  excluded_count integer,
  exclusion_reason_breakdown jsonb,
  -- Symbols not yet excluded for any listing reason, but whose price has never been successfully
  -- checked — a temporary, converging state (see market_universe_symbols.price_assessment_status),
  -- not an exclusion.
  awaiting_price_check_count integer,

  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  error text
);

create index if not exists market_universe_refresh_log_status_started_at_idx
  on market_universe_refresh_log (status, started_at desc);

-- Same rationale as market_universe_symbols: global, not per-user, and nothing but the
-- service-role worker/refresh CLI reads or writes it in this phase.
alter table market_universe_refresh_log enable row level security;

comment on table market_universe_refresh_log is
  'Phase 2A. One row per Market Universe refresh run — operational evidence (counts, exclusion reasons, duration) and the source of truth for whether the universe has ever been successfully refreshed. Global, service-role-only by design for this phase (RLS enabled, no policies).';
comment on column market_universe_refresh_log.exclusion_reason_breakdown is
  'Count of currently, settled-excluded symbols by reason (test_issue, unsupported_instrument_type, price_below_minimum, delisted), as of this run. Does not include symbols awaiting_price_check_count — see that column.';
comment on column market_universe_refresh_log.awaiting_price_check_count is
  'Symbols with no listing-level exclusion whose price has never been successfully checked — a temporary, converging state, not a settled exclusion. See market_universe_symbols.price_assessment_status.';
comment on column market_universe_refresh_log.status is
  'running while the refresh is in progress; completed or failed once it finishes. A failed run never touches market_universe_symbols — the existing universe is left exactly as it was.';
