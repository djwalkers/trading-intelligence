# Supabase Infrastructure

Status: **schema prepared, persistence disabled**. This is the infrastructure-level overview of
the Supabase database prepared for the Trading Intelligence platform. It is not connected to the
running app — see [`docs/product/BUILD-0.7.0.md`](../../docs/product/BUILD-0.7.0.md) for what
that means in practice.

## What exists

| Concern | Where |
|---|---|
| SQL migrations | `platform/web/supabase/migrations/` (5 files, run in numeric order) |
| Sample data | `platform/web/supabase/seed.sql` |
| Setup instructions | [`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) |
| Schema design & rationale | [`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md) |
| Environment variables | `platform/web/.env.example` |

## Tables

Three tables, all prototype-only (no auth, no real users yet):

- **`paper_trades`** — one row per paper trade (open or closed)
- **`trade_intelligence`** — 1:1 extension for Market Intelligence-sourced trades
- **`trade_events`** — append-only open/close audit log

Indexed on `created_at`, `status`, `source`, `instrument_symbol`, and `side` (on `paper_trades`),
plus the foreign key columns on the two extension tables.

Row Level Security is enabled on all three tables with permissive placeholder policies — see the
comment block in `0005_row_level_security.sql` for exactly what that means and what replaces it
once authentication exists.

## What this environment is not, yet

- Not linked to any deployed environment (staging/production) — no `supabase/config.toml` project
  link exists in this repo.
- Not connected to the running app. `platform/web` still persists paper trades to `localStorage`
  regardless of whether a Supabase project exists or environment variables are set.
- Not backed by CI — there is no automated migration-check or deploy pipeline for this schema yet.

## Operating this once it's live (future)

When a future build wires up real persistence (see the migration path in
`SUPABASE-PERSISTENCE-PLAN.md`), this file should be updated to record: which Supabase project(s)
back which environment, how migrations are deployed (CLI in CI vs. manual SQL Editor runs), and
who/what is on call if the database has an incident. None of that exists yet because there is no
live database to operate.
