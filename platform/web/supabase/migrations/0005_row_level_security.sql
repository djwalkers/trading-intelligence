-- Build 0.7.0 — Row Level Security placeholders
--
-- STATUS: prototype-only. There is no authentication in the app yet, so these tables have no
-- user_id column to scope policies on. RLS is enabled defensively — so the anon key can't be
-- used to bypass RLS by accident once these tables are exposed via the Supabase API — but the
-- policies below are permissive placeholders, NOT a real security boundary. Do not treat this
-- as production-ready access control.
--
-- FUTURE (user-scoped): once auth is introduced, add a `user_id uuid references auth.users`
-- column to paper_trades, drop the placeholder policies below, and replace them with policies
-- of the form `using (auth.uid() = user_id)` on all three tables — trade_intelligence and
-- trade_events can inherit scope via their paper_trade_id foreign key (e.g. a policy that joins
-- back to paper_trades and checks its user_id).

alter table paper_trades enable row level security;
alter table trade_intelligence enable row level security;
alter table trade_events enable row level security;

create policy "Prototype: allow all access to paper_trades"
  on paper_trades for all
  using (true)
  with check (true);

create policy "Prototype: allow all access to trade_intelligence"
  on trade_intelligence for all
  using (true)
  with check (true);

create policy "Prototype: allow all access to trade_events"
  on trade_events for all
  using (true)
  with check (true);
