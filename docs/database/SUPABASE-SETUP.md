# Supabase Setup Guide

Status: **as of Build 1.1.0, this guide turns on real persistence AND authentication; Build 1.2.0
adds password reset and entry price provenance columns.** Once you complete steps 1–5 below, the
app requires sign-in and scopes paper trades to the signed-in user via Row Level Security, instead
of the localStorage/no-auth prototype default. See
[`docs/product/BUILD-0.9.0.md`](../product/BUILD-0.9.0.md),
[`docs/product/BUILD-1.1.0.md`](../product/BUILD-1.1.0.md), and
[`docs/product/BUILD-1.2.0.md`](../product/BUILD-1.2.0.md) for what changed, and
[`SUPABASE-PERSISTENCE-PLAN.md`](./SUPABASE-PERSISTENCE-PLAN.md) for the original schema rationale.

You do not need to do any of this to run the app — `npm run dev` works with zero configuration,
using `localStorage` and no sign-in by default.

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
0006_add_user_id_to_paper_trades.sql
0007_user_scoped_row_level_security.sql
0008_add_entry_price_provenance.sql
```

**If you already ran 0001–0007 for an earlier build**, you only need to run 0008 now — it's
additive (three new nullable columns on `paper_trades`, none of them required for anything already
working). 0007 drops the permissive "allow all" policies from 0005 and replaces them with policies
scoped to `auth.uid() = user_id`; existing rows keep working, but see step 5 below for what happens
to rows that predate 0006.

**Option A — SQL Editor (fastest, no CLI needed):** open each file in order, paste its contents
into the SQL Editor, and run it. Repeat for all eight, in order — later files reference tables
(or policies) created by earlier ones.

**Option B — Supabase CLI**, if you have a project linked:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Don't load `platform/web/supabase/seed.sql` if you plan to use the app's first-run import (step
6) — it expects your `paper_trades` table to start empty. The seed file is for manually poking at
the schema in Supabase Studio, not for combining with real app usage, and predates the `user_id`
and entry-price-provenance columns — seeded rows will have all four as `null`, just like any other
pre-Build-1.1.0 row.

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

`.env.local` is already gitignored — never commit real credentials, and never put a service role
key here or anywhere else in this app; only the public anon key is ever used
(`src/lib/supabase/client.ts`, shared by persistence and auth), relying on the RLS policies from
step 2 for access control.

Restart `npm run dev` after adding or changing `.env.local` — Next.js only reads environment
variables at startup.

## 4. Create an account and sign in

As of Build 1.1.0, setting the two variables above also turns on Supabase Auth and gates the
whole app behind sign-in. Open the app — you'll land on `/sign-up` (or be redirected there from
any other page). Create an account with any email/password (6+ characters).

**If your Supabase project has "Confirm email" enabled** (the default for new projects), you'll
see "Account created. Check your email to confirm your address, then sign in" — you must click
the confirmation link before you can sign in. To skip this during local development, you can
disable it under **Authentication → Providers → Email → Confirm email** in the Supabase
dashboard, or just use a real inbox you control.

Once signed in, you'll land on the Dashboard like any other build.

**Forgot your password?** Since Build 1.2.0, `/sign-in` has a "Forgot password?" link to
`/forgot-password`. Requesting a reset sends an email via Supabase Auth (no schema changes
needed — this uses `auth.users`, not any table in this project); the link in that email lands on
`/reset-password`, which lets you set a new password and signs you straight into the Dashboard.

## 5. Verify the tables

In the Supabase dashboard's **Table Editor**, confirm all three tables exist:
`paper_trades`, `trade_intelligence`, `trade_events`, and that `paper_trades` now has `user_id`,
`entry_price_source`, `entry_price_provider`, and `entry_price_timestamp` columns. If you loaded
the seed data, `paper_trades` should show 3 rows (two open, one closed, `user_id` and the three
entry-price columns all null since the seed predates both), `trade_intelligence` should show 1
row, and `trade_events` should show 4 rows.

Or verify from the SQL Editor:

```sql
select status, source, user_id, count(*) from paper_trades group by status, source, user_id;
select column_name from information_schema.columns where table_name = 'paper_trades';
select count(*) from trade_intelligence;
select event_type, count(*) from trade_events group by event_type;
select policyname from pg_policies where tablename = 'paper_trades';
```

## 6. First run

Once signed in, go to **System Health** — the new Authentication panel should show "Auth:
Enabled", your email under "Current user", and "Data scope: User scoped". The Persistence panel
should show "Current mode: Supabase" and "Connection: Connected". If Persistence instead shows
"Local Browser Storage" with a connection error, something in steps 1–3 needs another look (see
Troubleshooting below).

If this browser already had paper trades saved locally before you configured Supabase, and your
signed-in user has none in Supabase yet, you'll see a one-time prompt: **"Import existing paper
trading history?"** with Import and Skip buttons. This only appears once per browser — whichever
you choose, it won't ask again. (Note: the import-resolved flag is browser-wide, not per-user — a
second user signing in on the same browser after the first has already answered won't be offered
the prompt again, even if their own situation would otherwise warrant it.)

## Troubleshooting

If Supabase is configured but unreachable (wrong URL, project paused, network blocked, RLS
misconfigured), **the app does not break** — it logs the error to the browser console
(`[persistence] Supabase unavailable, falling back to local storage: ...`), shows a small banner
("Persistence unavailable. Falling back to local storage."), and continues working against
`localStorage` for the rest of that session. Fix the underlying issue and reload the page to try
Supabase again — the app does not automatically retry mid-session.

**"Email not confirmed" when signing in** — your project requires email confirmation (see step 4);
click the link in the confirmation email, or disable "Confirm email" for local development.

**A trade you created before Build 1.1.0 has disappeared** — it wasn't deleted. Rows created
before migration `0006` have `user_id = null`, which the user-scoped policies in `0007` treat as
belonging to no one. Claim it manually:

```sql
update paper_trades set user_id = '<uuid-of-the-signed-up-user>' where user_id is null;
```

Find the user's id in Supabase Studio under **Authentication → Users**, or via
`select id from auth.users where email = '<their-email>';`.

**Placing a trade fails, or persistence silently falls back to local storage, after upgrading to
Build 1.2.0** — you likely haven't run `0008_add_entry_price_provenance.sql` yet. Without it,
inserting a trade fails on the unknown `entry_price_source`/`entry_price_provider`/
`entry_price_timestamp` columns, which `ResilientPaperTradeStore` treats as a generic failure and
falls back to local storage for the rest of that session. Run `0008` and reload the page.

## Rolling back

Removing `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` from `.env.local` (or
deleting the file) reverts the app to `localStorage` and no-auth prototype mode on the next
reload. Nothing is deleted from either side — your Supabase data (and every signed-up account)
stays in Supabase, and any `localStorage` history from before you switched is still there too.
