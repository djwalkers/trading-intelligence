-- Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota).
--
-- Supports the new bounded SupabaseTradeLifecycleStore.countConfirmedEntriesForUtcDay query — see
-- src/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store.ts — which replaced
-- trading-runtime.ts's/market-decide.ts's own former "download the entire trade_lifecycle_records
-- table (JSONB `detail` blob included) every cycle, then count client-side" pattern with:
--
--   select id, { count: "exact", head: true }
--   where user_id = :userId and strategy_id = :strategyId
--     and opened_at >= :startInclusive and opened_at < :endExclusive
--
-- None of migration 0026's existing indexes cover this filter shape: user_status_idx leads with
-- status (not strategy_id/opened_at), and user_strategy_instrument_idx's third column is
-- `instrument`, not `opened_at`, so a strategy-scoped opened_at-range count would still need to scan
-- every row for that (user_id, strategy_id) pair rather than seek directly into the date range.
-- Purely additive — no existing table, column, index, or policy is altered or dropped.
create index if not exists trade_lifecycle_records_user_strategy_opened_at_idx
  on trade_lifecycle_records (user_id, strategy_id, opened_at);

comment on index trade_lifecycle_records_user_strategy_opened_at_idx is
  'Supports SupabaseTradeLifecycleStore.countConfirmedEntriesForUtcDay''s bounded, count-only, strategy-scoped opened_at-range query (egress-containment fix) — never a full-table scan.';
