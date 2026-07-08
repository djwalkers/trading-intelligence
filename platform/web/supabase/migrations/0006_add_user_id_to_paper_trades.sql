-- Build 1.1.0 — user_id on paper_trades
--
-- Adds user scoping ahead of user-scoped RLS (0007). Nullable, not "not null": existing
-- prototype rows (created before Supabase Auth existed in this app) have no owning user, and
-- this migration must not fail or delete them just because they predate auth.
--
-- trade_intelligence and trade_events are NOT given their own user_id column — they stay linked
-- to their owning trade only through paper_trade_id, exactly as before. Their RLS policies (0007)
-- scope them by joining back to paper_trades instead.
--
-- Rows left with user_id = null after this migration become invisible under 0007's user-scoped
-- policies (auth.uid() = user_id is never true when user_id is null) — see
-- docs/database/SUPABASE-SETUP.md for how to manually claim them under a real account.

alter table paper_trades
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

create index if not exists paper_trades_user_id_idx on paper_trades (user_id);

comment on column paper_trades.user_id is
  'Owning user (Build 1.1.0). Null on rows created before auth existed — see docs/database/SUPABASE-SETUP.md for how to claim them.';
