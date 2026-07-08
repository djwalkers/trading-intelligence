-- Build 1.1.0 — user-scoped Row Level Security
--
-- Replaces the permissive placeholder policies from 0005_row_level_security.sql now that
-- paper_trades has a user_id column to scope on (0006). trade_intelligence and trade_events have
-- no user_id column of their own — they inherit scope by joining back to paper_trades through
-- paper_trade_id, exactly as anticipated in 0005's original comments.
--
-- STATUS: this is now a real security boundary for paper_trades access (assuming Supabase Auth
-- is the only way to obtain a JWT for this project) — a meaningful step up from 0005's
-- "enabled but permissive" placeholders, though this app still has no concept of roles,
-- ownership transfer, or admin access beyond "a row belongs to exactly the user who created it."
--
-- Rows with user_id = null (created before 0006) are now invisible to every user, including
-- whoever originally created them — auth.uid() = user_id is never true when user_id is null.
-- This is non-destructive: the rows still exist and can be claimed by manually setting their
-- user_id (see docs/database/SUPABASE-SETUP.md).

drop policy if exists "Prototype: allow all access to paper_trades" on paper_trades;
drop policy if exists "Prototype: allow all access to trade_intelligence" on trade_intelligence;
drop policy if exists "Prototype: allow all access to trade_events" on trade_events;

-- paper_trades: straightforward, user_id is a column on the table itself.

create policy "Users can view their own paper trades"
  on paper_trades for select
  using (auth.uid() = user_id);

create policy "Users can insert their own paper trades"
  on paper_trades for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own paper trades"
  on paper_trades for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own paper trades"
  on paper_trades for delete
  using (auth.uid() = user_id);

-- trade_intelligence and trade_events: scoped via a join back to paper_trades, since neither
-- table has its own user_id column. The app only ever selects and inserts these (never updates
-- or deletes them directly), so only those policies are defined.

create policy "Users can view intelligence for their own trades"
  on trade_intelligence for select
  using (
    exists (
      select 1 from paper_trades
      where paper_trades.id = trade_intelligence.paper_trade_id
        and paper_trades.user_id = auth.uid()
    )
  );

create policy "Users can insert intelligence for their own trades"
  on trade_intelligence for insert
  with check (
    exists (
      select 1 from paper_trades
      where paper_trades.id = trade_intelligence.paper_trade_id
        and paper_trades.user_id = auth.uid()
    )
  );

create policy "Users can view events for their own trades"
  on trade_events for select
  using (
    exists (
      select 1 from paper_trades
      where paper_trades.id = trade_events.paper_trade_id
        and paper_trades.user_id = auth.uid()
    )
  );

create policy "Users can insert events for their own trades"
  on trade_events for insert
  with check (
    exists (
      select 1 from paper_trades
      where paper_trades.id = trade_events.paper_trade_id
        and paper_trades.user_id = auth.uid()
    )
  );
