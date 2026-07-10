# Build 1.1.0 — Supabase Authentication & User-Scoped Paper Trading

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`BUILD-0.9.0.md`](./BUILD-0.9.0.md), [`BUILD-1.0.0.md`](./BUILD-1.0.0.md),
[`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md)

## What was built

Supabase Auth now sits in front of the whole app **when Supabase is configured**. Paper trades are
scoped to the signed-in user, in the database and in the UI. **Local prototype mode (no env
vars) is completely unaffected** — no sign-in, no gating, exactly as before.

- **Email/password auth.** Sign up, sign in, and sign out, via Supabase Auth
  (`@supabase/supabase-js`'s `auth` API) through a new shared client
  (`src/lib/supabase/client.ts`) used by both auth and persistence, so they share one session.
  New `/sign-in` and `/sign-up` pages, styled to match the existing dark theme, rendered in a
  minimal centered layout (no sidebar — there's nothing to navigate to yet).
- **Protected app shell.** A new `AuthGate` wraps every other page. When Supabase is configured
  and there's no signed-in user, it redirects to `/sign-in`; when Supabase isn't configured, it
  renders children immediately, unconditionally. Sign-out is available from the sidebar, showing
  the signed-in user's email.
- **`user_id` on `paper_trades`.** New migration adds a nullable `user_id uuid references
  auth.users(id)` column. `trade_intelligence` and `trade_events` are not given their own user_id
  — they remain linked only through `paper_trade_id`, and are scoped in RLS by joining back to
  `paper_trades`.
- **User-scoped Row Level Security.** A second new migration drops the permissive
  "allow all" placeholder policies from Build 0.7.0 and replaces them with `auth.uid() = user_id`
  policies on `paper_trades` (select/insert/update/delete) and join-based policies on
  `trade_intelligence`/`trade_events` (select/insert). This is now a real security boundary, not a
  placeholder.
- **Persistence layer updated for auth.** `SupabasePaperTradeStore` requires a live session for
  every operation, stamps `user_id` on insert, and explicitly filters reads/updates by it (in
  addition to, not instead of, RLS enforcing the same thing server-side). If there's no session,
  it throws a distinct `AuthRequiredError` — caught by `ResilientPaperTradeStore`, which does
  **not** fall back to local storage for this specific error (that would silently start saving to
  an unscoped store, which is wrong for a user-scoped app); it rethrows instead, and `AuthGate` is
  what actually gets the user back to sign-in.
- **Session-expiry messaging.** `AuthContext` tracks whether the current tab previously had a
  session; if it transitions from signed-in to signed-out without the user calling `signOut()`
  themselves, that's treated as an expired session rather than "never signed in," and the sign-in
  page shows "Your session has expired. Please sign in again."
- **`PaperTradesProvider` now re-hydrates on identity change.** Previously it loaded trades once
  on mount; with auth, "once on mount" isn't enough — the first mount can happen before a session
  exists, or a different user can sign in on the same tab later. It now re-runs whenever the
  effective identity (local / unauthenticated / a specific user id) changes, clearing state first
  so one user's trades never linger after another signs in.
- **System Health, extended.** A new "Authentication" panel: Auth (Enabled/Disabled), Current user
  (email, when signed in), Data scope (User scoped / Local prototype) — live, reading directly
  from `AuthContext`.

## Database / RLS changes

New migrations (run after the five from Build 0.7.0):

- **`0006_add_user_id_to_paper_trades.sql`** — adds `paper_trades.user_id` (nullable uuid, `on
  delete cascade` from `auth.users`), plus an index. Nullable specifically so it doesn't fail or
  delete existing prototype rows that predate auth.
- **`0007_user_scoped_row_level_security.sql`** — drops the three permissive placeholder policies
  from `0005_row_level_security.sql`; adds `auth.uid() = user_id` policies for
  select/insert/update/delete on `paper_trades`, and select/insert policies on
  `trade_intelligence`/`trade_events` that check ownership via a join back to `paper_trades`
  (neither table has its own `user_id` column).

## Manual Supabase steps required

**Applying these migrations is a manual step** — same as every schema change in this project since
Build 0.7.0. The app only ever uses the public anon key, which cannot run DDL (`alter table`,
`create policy`); this requires the Supabase SQL Editor (or a service-role/CLI-authenticated
connection, neither of which this app is ever given). To adopt Build 1.1.0 against a real project:

1. Open the Supabase SQL Editor.
2. Run `0006_add_user_id_to_paper_trades.sql`, then `0007_user_scoped_row_level_security.sql`, in
   order.
3. **Existing rows created before this migration will have `user_id = null`.** Under the new
   policies, `auth.uid() = user_id` is never true when `user_id` is null — those rows become
   invisible to everyone, including whoever originally created them. They are **not deleted**;
   to make an existing prototype trade visible again, manually claim it after signing up:
   ```sql
   update paper_trades set user_id = '<uuid-of-the-signed-up-user>' where user_id is null;
   ```
   Find `<uuid-of-the-signed-up-user>` in Supabase Studio under Authentication → Users, or via
   `select id from auth.users where email = '<their-email>';`.
4. Confirm the two new columns/policies exist: `select column_name from information_schema.columns
   where table_name = 'paper_trades';` should include `user_id`; `select policyname from
   pg_policies where tablename = 'paper_trades';` should show the four new user-scoped policies,
   not the old "allow all" one.

See the updated [`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md) for the full
walkthrough, including account sign-up.

## Architecture notes

```
src/lib/supabase/
  client.ts      — getSupabaseClient(): one client, shared by auth and persistence
  config.ts      — isSupabaseConfigured() (moved here from lib/persistence/config.ts —
                   now a shared concern, not persistence-specific)

src/lib/auth/
  auth-context.tsx — AuthProvider/useAuth(): isConfigured, isLoading, user, sessionExpired,
                     signUp/signIn/signOut

src/components/layout/AuthGate.tsx  — redirect-to-sign-in when configured and signed out
src/components/auth/AuthForm.tsx    — shared sign-in/sign-up form
src/app/sign-in/, src/app/sign-up/  — pages using AuthForm

src/lib/persistence/auth-required-error.ts — thrown by SupabasePaperTradeStore when there's no
                                              session; recognized specially by
                                              ResilientPaperTradeStore (no fallback, just rethrow)
```

Provider order in `layout.tsx` is `AuthProvider` → `PaperTradesProvider` → `AppShell`:
`PaperTradesProvider` needs to read auth state (to know whose trades to load and when to
re-hydrate), so it must be a descendant of `AuthProvider`.

**Why `PaperTradesProvider` was restructured, not just extended:** the original hydration effect
ran once on mount with an empty dependency array. Adding auth without changing this would mean a
user who signs in gets nothing loaded — the one hydration attempt already happened (and failed,
with no session) before they signed in. The fix re-keys hydration on an `authKey` (`"local"` for
prototype mode, `"pending"` while the initial auth check is in flight, otherwise the user's id or
`"unauthenticated"`), and derives `trades`/`isHydrated` from comparing the loaded data's key
against the current one — the same pattern used for `useMarketQuotes` in Build 1.0.0 — rather than
resetting state imperatively inside the effect (which an ESLint rule, `react-hooks/set-state-in-
effect`, correctly flags as a footgun).

**Why `AuthRequiredError` doesn't trigger the local-storage fallback:** `ResilientPaperTradeStore`
already has a fallback mechanism for "Supabase is unreachable." Auth-required is a different kind
of failure — the backend is fine, there's just no signed-in user — and falling back to local
storage would be actively wrong for a user-scoped app: trades would silently start saving to an
unscoped browser store instead of surfacing that sign-in is needed. `AuthRequiredError` is
recognized and rethrown instead, before the generic fallback branch runs.

## What is intentionally not included yet

- No broker execution, no live order placement, no AI, no "Hermes" — exactly as instructed.
- No password reset / magic link / OAuth providers — email/password only.
- No roles, teams, or shared/admin access — a trade belongs to exactly the user who created it.
- No per-user scoping of the first-run import prompt (`IMPORT_PROMPT_RESOLVED_KEY` is a single
  browser-wide flag from Build 0.9.0) — if a second user signs in on a browser where the first
  user already answered the import prompt, they won't be offered it even if their own situation
  would otherwise warrant it. Worth revisiting if multi-user-per-browser becomes a real scenario.
- No server-side session verification (middleware, protected API routes) — gating is client-side
  only (`AuthGate`), appropriate for this prototype's architecture (no server actions or API
  routes exist yet) but not a substitute for server-side checks in a production app.
- Signal/Market Intelligence trade entry pricing still uses the static mock instrument price
  (unchanged from Build 1.0.0) — unrelated to this build's scope.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required — local prototype mode has no auth concept at all. To try
real auth: follow `docs/database/SUPABASE-SETUP.md`, run all seven migrations, copy `.env.example`
to `.env.local`, fill in your project's URL and anon key, then sign up from `/sign-up`.

`npm run lint` and `npm run build` both pass cleanly. Manually verified in this build:

- **Local prototype mode (no env vars):** full regression — Dashboard, Watchlist, Portfolio,
  Trade Journal, System Health all load with no gating; placing and closing a paper trade works
  end-to-end exactly as in every prior build; System Health's new Authentication panel correctly
  shows Auth: Disabled, Current user: N/A, Data scope: Local prototype.
- **With Supabase configured:** visiting any app route while signed out correctly redirects to
  `/sign-in`, rendered in the minimal centered layout with no sidebar; sign-up against the real,
  connected project succeeds and shows the "check your email to confirm" message; attempting to
  sign in before confirming shows a clear "Email not confirmed" error from Supabase itself
  (verifying the error-surfacing path); after restoring the original `.env.local`, the app
  correctly resumes gating behaviour with no regressions from the round trip.

**Not verified end-to-end in this environment, and disclosed accordingly** (the user was asked
and chose to proceed without live migration testing, matching the disclosure pattern from Builds
0.7.0/0.9.0):

- **Migrations 0006/0007 were not applied to the live connected project** — applying them requires
  the Supabase SQL Editor or a service-role key, and this app is only ever given the anon key.
  The authenticated write path (`user_id` stamping, user-scoped reads, RLS enforcement) is
  implemented and reviewed against the documented schema, but not live-tested against actual
  Supabase responses.
  - As a direct consequence, "signed-in user can create paper trades," "signed-in user can close
    trades," and "Trade Journal only shows that user's trades" were **not** verified against a
    real authenticated Supabase session in this environment.
- **This project's Supabase Auth settings require email confirmation before sign-in**, and no
  inbox was available to confirm a test account, so the full sign-up → confirm → sign-in →
  authenticated-app happy path could not be completed live either — only sign-up (succeeded) and
  sign-in against an unconfirmed account (correctly rejected with "Email not confirmed") were
  exercised.

Anyone adopting this should run the two new migrations, confirm a real test account by email, and
verify the authenticated create/close/Trade-Journal-scoping paths against their own project before
relying on them.

## Suggested Build 1.2.0

With auth and user-scoped RLS in place, the next gap is that the RLS boundary has only been
reviewed, not exercised against live traffic — worth a dedicated verification pass once a
confirmable test account is available. Beyond that: extend the market data provider (Build 1.0.0)
to Signal/Market Intelligence trade entry pricing, so a trade's entry price and its ongoing
valuation finally share one source; and/or add password reset, since email/password-only auth
with no recovery path is a real gap for anyone who forgets their password.
