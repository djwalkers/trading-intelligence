# Supabase Setup Guide

Status: this guide lets you stand up and verify the database schema. **It does not turn on
Supabase persistence in the app.** As of Build 0.7.0 the app still reads and writes paper trades
exclusively through `localStorage` — see
[`docs/product/BUILD-0.7.0.md`](../product/BUILD-0.7.0.md) and
[`SUPABASE-PERSISTENCE-PLAN.md`](./SUPABASE-PERSISTENCE-PLAN.md) for why, and what a future build
needs to do to actually switch it on.

Follow this guide if you want to see the schema exist and hold data in a real Supabase project.
You do not need to do any of this to run the app — `npm run dev` works with zero configuration.

## 1. Create a project

1. Go to [supabase.com](https://supabase.com) and create a new project (any name/region).
2. Wait for provisioning to finish, then open the project's SQL Editor.

## 2. Run the migrations

The migration files live in `platform/web/supabase/migrations/`, numbered in the order they must
run:

```
0001_create_paper_trades.sql
0002_create_trade_intelligence.sql
0003_create_trade_events.sql
0004_add_indexes.sql
0005_row_level_security.sql
```

**Option A — SQL Editor (fastest, no CLI needed):** open each file in order, paste its contents
into the SQL Editor, and run it. Repeat for all five, in order — later files reference tables
created by earlier ones.

**Option B — Supabase CLI**, if you have a project linked:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Then, optionally, load the sample data:

```bash
supabase db execute -f platform/web/supabase/seed.sql
```

(or paste `platform/web/supabase/seed.sql` into the SQL Editor, same as the migrations).

## 3. Add environment variables

From your project's **Settings → API** page, copy the Project URL and the `anon` public key.

In `platform/web/`, copy the example file:

```bash
cp .env.example .env.local
```

Fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

`.env.local` is already gitignored — never commit real credentials.

## 4. Verify the tables

In the Supabase dashboard's **Table Editor**, confirm all three tables exist:
`paper_trades`, `trade_intelligence`, `trade_events`. If you loaded the seed data, `paper_trades`
should show 3 rows (two open, one closed), `trade_intelligence` should show 1 row, and
`trade_events` should show 4 rows.

Or verify from the SQL Editor:

```sql
select status, source, count(*) from paper_trades group by status, source;
select count(*) from trade_intelligence;
select event_type, count(*) from trade_events group by event_type;
```

## 5. Do not enable app persistence yet

Setting `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` only
changes what the **System Health** page reports ("Supabase: Configured" instead of "Not
configured"). It does **not** change where paper trades are stored — `getPaperTradeStore()`
(`platform/web/src/lib/persistence/get-paper-trade-store.ts`) always returns the local storage
implementation today. `SupabasePaperTradeStore` is a placeholder that throws if it's ever called,
and nothing in the app calls it.

This is deliberate: it means you can safely follow this entire guide, including setting real
credentials, without any risk of the app's persistence behaviour changing underneath you. Actually
switching persistence over is future work — see the migration path in
[`SUPABASE-PERSISTENCE-PLAN.md`](./SUPABASE-PERSISTENCE-PLAN.md).
