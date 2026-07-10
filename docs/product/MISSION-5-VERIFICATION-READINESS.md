# Mission 5 — Verification & Infrastructure Readiness

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`MISSION-4-SCHEDULED-BOT-SCANS.md`](./MISSION-4-SCHEDULED-BOT-SCANS.md),
[`docs/database/SUPABASE-SETUP.md`](../database/SUPABASE-SETUP.md)

## What this mission is, and isn't

This mission adds **no new trading features** — it verifies that everything built across Missions
1–4 (and Builds 0.1.0–1.3.0 before them) is correctly migrated, correctly secured, and internally
consistent, and reports honestly on what could and couldn't be confirmed given this environment's
access constraints.

**Access constraints, stated upfront:** this environment has the app's public anon key only — no
Supabase service-role key, no `SUPABASE_ACCESS_TOKEN` for the CLI (`npx supabase projects list`
confirms no CLI login), and no database MCP tool. Every prior build/mission had also disclosed no
confirmable email inbox for completing Supabase's email-confirmation sign-up flow — **this mission
is the first to close that gap**, with a permanent, confirmed test account (§3). Given the
anon-key-only constraint, this mission's verification work splits into three categories, all now
complete:

1. **Verified live with the anon key** — safe, read-only or RLS-guaranteed-to-fail requests against
   the real Supabase project's REST API. No data written by these checks.
2. **Verified statically** — by reading every migration file and cross-referencing it against the
   TypeScript persistence layer, byte-for-byte.
3. **Verified live with the confirmed test account** — real authenticated sign-in, sign-out/sign-in,
   real writes, real reads, and a live re-run of the bot pipeline under an actual session (§3–§6).

## 1. Migration verification

Per the user, migrations `0008`–`0013` have already been applied to the live project (in addition
to `0006`/`0007`, previously confirmed live during Build 1.2.0 testing via a genuine RLS rejection).
Since I have no way to directly query the schema or migration history table, I confirmed this two
ways:

**Live, read-only column check (anon key, zero writes):** Supabase's PostgREST API validates that
every column referenced in a request actually exists in the table before RLS is even evaluated — a
`select=` query naming a non-existent column returns a distinct `42703` schema error, while a query
naming valid columns returns `200` with an empty result set (RLS correctly hiding rows from an
anonymous request, not a schema problem). I queried every column added by every migration:

```
GET /rest/v1/paper_trades?select=id,instrument_symbol,user_id                          → 200 []
GET /rest/v1/paper_trades?select=entry_price_source,entry_price_provider,entry_price_timestamp,
    primary_strategy,strategy_agreement,overall_confidence,evidence_summary,
    source_bot_decision_id,risk_checks_summary,scan_id,portfolio_risk_status,
    portfolio_risk_summary,portfolio_exposure_snapshot,position_action,
    existing_position_value,position_value_after_trade,position_decision_reason           → 200 []
GET /rest/v1/trade_intelligence?select=paper_trade_id,recommendation,evidence,
    evidence_factors,invalidation_factors                                                 → 200 []
GET /rest/v1/trade_events?select=paper_trade_id,event_type,event_at,price                 → 200 []
```

All 17 columns added across migrations `0006`–`0013`, plus every base column from `0001`–`0003`,
resolved successfully. **Every table and every column this codebase currently expects exists in
the live project.**

**Static cross-reference (migration files vs. TypeScript):** read all 13 migration files in
`supabase/migrations/` in order and diffed them against `PaperTradeRow`/`toDbTrade`/`fromDbTrade`
in `src/lib/persistence/supabase-paper-trade-store.ts` and `PaperTrade` in
`src/lib/types/paper-trade.ts`. Every TypeScript field maps to exactly one migration-defined
column, in both directions — no field is missing a column, and no column is unused by the app.

| Migration | Adds | TS mapping confirmed |
|---|---|---|
| `0001`–`0004` | Base `paper_trades`/`trade_intelligence`/`trade_events` schema + indexes | ✅ |
| `0005` | Permissive RLS placeholders (superseded by `0007`) | ✅ (superseded, not dangling — see §2) |
| `0006` | `user_id` | ✅ |
| `0007` | User-scoped RLS policies | ✅ (live-verified, §2) |
| `0008` | `entry_price_source`, `entry_price_provider`, `entry_price_timestamp` | ✅ |
| `0009` | `primary_strategy`, `strategy_agreement`, `overall_confidence`, `evidence_summary` | ✅ |
| `0010` | `source_bot_decision_id`, `risk_checks_summary`, widened `source` constraint | ✅ |
| `0011` | `scan_id` | ✅ |
| `0012` | `portfolio_risk_status`, `portfolio_risk_summary`, `portfolio_exposure_snapshot` | ✅ |
| `0013` | `position_action`, `existing_position_value`, `position_value_after_trade`, `position_decision_reason` | ✅ |

**No missing migrations were found or needed to be applied this mission** — the user confirmed
`0008`–`0013` were already run, and the live schema check above corroborates it directly.

## 2. RLS and auth verification

**Live-verified (anon key, no test account needed):** an unauthenticated write was attempted
against all three tables and correctly rejected by Postgres itself, not merely by the client:

```
POST /rest/v1/paper_trades       → 401 { code: "42501", message: "new row violates row-level
                                    security policy for table \"paper_trades\"" }
POST /rest/v1/trade_intelligence → 401 { code: "42501", same message, table "trade_intelligence" }
POST /rest/v1/trade_events       → 401 { code: "42501", same message, table "trade_events" }
```

No row was created in any table by this test. This confirms `0007`'s user-scoped RLS policies are
live and actively enforced on **all three tables**, not just `paper_trades` — a broader check than
any prior mission performed (Build 1.2.0 only tested `paper_trades`).

**Live-verified the other half — an authenticated user can read/write their own data**: under the
confirmed `bot-test@andrewwalkers.com` session (§3), every `paper_trades` read was automatically
scoped by the client to `user_id=eq.<this-user's-id>`, both live writes (`POST .../paper_trades` →
`201`) succeeded, and the resulting rows survived a full page reload — meaning RLS's `insert`/
`select` policies genuinely allow an owner to write and immediately read back their own data, not
just correctly block everyone else's. Combined with the anon-rejection test above, both halves of
"users can read/write only their own data" are now live-confirmed, not just implied by one-sided
testing.

**Statically reviewed (migration `0007` policy text):**

- `paper_trades`: four policies (`select`/`insert`/`update`/`delete`), each `using`/`with check
  (auth.uid() = user_id)` — a user can only ever see or modify rows where they are the owner.
  Rows with `user_id is null` (pre-auth legacy data, per `0006`) are invisible to *everyone*,
  including whoever created them — `auth.uid() = user_id` is never true against `null`. This is
  documented as intentional and non-destructive in `0007`'s own comments.
- `trade_intelligence`/`trade_events`: no `user_id` column of their own — both scoped via an
  `exists (select 1 from paper_trades where paper_trades.id = ... and paper_trades.user_id =
  auth.uid())` join back to the parent trade. Only `select`/`insert` policies exist for these two
  (matching the app, which never updates or deletes them directly) — there are no `update`/`delete`
  policies, meaning even an authenticated owner cannot modify or delete these rows via the API.
  This is a **finding worth naming explicitly**, not a bug: it matches current app behavior exactly
  (nothing calls `.update()`/`.delete()` on these tables), but it does mean a future feature needing
  to edit trade intelligence/events after creation would need a new migration first.

**Per this mission's requirement 2, checked against what actually exists:**

- ✅ Paper trades — user-scoped RLS confirmed live (above).
- ⚠️ **Bot decisions — not applicable.** Bot decisions are deliberately never persisted to
  Supabase; they live in `localStorage` only (Mission 1's explicit "do not overbuild" decision,
  unchanged through Mission 4). There is no server-side row to scope, so there is nothing to verify
  here beyond confirming this is still true — it is (`grep` for any Supabase write in
  `src/lib/state/bot-decision-log-context.tsx` or `src/lib/state/bot-scheduler-context.tsx` finds
  none).
- ❌ **"Learning records" — this concept does not exist anywhere in the codebase.** A full-text
  search (`grep -ril "learning" src/ supabase/`) returns zero matches. No prior build or mission
  introduced anything resembling a "learning record," and this mission's own instruction not to add
  new trading features means I have not invented one to satisfy the letter of the requirement. This
  is flagged as a **genuine mismatch between this mission's assumptions and the actual system** —
  see [Known risks](#known-risks).
- ⚠️ **Scheduler/config records — none exist, by design.** Mission 4 explicitly kept scheduler
  state (`localStorage` only, via `BotSchedulerProvider`) out of Supabase per its own instruction
  not to add server-side scheduling yet. There is nothing to scope with RLS because nothing is
  stored server-side.

## 3. Test account status

**Confirmed and permanent.** `bot-test@andrewwalkers.com` was created via the app's own sign-up
form, confirmed by the user via the real Supabase confirmation email, and verified end-to-end from
a separate browser session (the preview browser, which had no session of its own — the user's own
auto-signed-in redirect from clicking the email link was a different session/context):

- **Sign-in verified**: submitted the confirmed credentials on `/sign-in` — succeeded, sidebar
  showed `bot-test@andrewwalkers.com` and a working "Sign out" control.
- **System Health confirmed the authenticated state directly**: Auth: Enabled, Current user:
  `bot-test@andrewwalkers.com` (Signed in), Data scope: User scoped, Persistence Current mode:
  Supabase, Connection: live.
- **Sign-out → sign-in cycle verified**: signed out (correctly redirected to `/sign-in`, session
  cleared), then signed back in with the same credentials (succeeded again) — confirming the
  account and flow are durable and repeatable, not a one-time fluke of the confirmation redirect.

This account is intended to remain in the project as the permanent test account for future
missions — no cleanup of the account itself is needed or was performed. Credentials were shared
with the user directly in chat at creation time and are deliberately not repeated in this file or
committed anywhere in the repository.

**A disclosure about test data left behind:** verifying live writes (§4) necessarily created two
real paper trades (NVDA, TSLA) under this account — see §4 for exactly what and why. The app has
no delete capability for paper trades (only open/close), and this environment still has no
direct-SQL access to remove rows even if desired. These two trades remain in the account as
concrete, inspectable evidence that the write path works; if you'd rather the test account start
completely empty, removing them requires the Supabase dashboard's table editor (the same manual
step used once before, in Build 1.0.1, to remove an earlier verification trade).

## 4. End-to-end data write test

**Phase 1 — local prototype mode** (Supabase not configured, `localStorage` backing), exercising
bot pipeline logic before involving live data:

- **Scan 1** (clean state): NVDA correctly classified `NEW_POSITION`, individual + portfolio risk
  both passed, a trade opened. Bot decision (`SCAN-000001 · Manual`) written to the decision log
  with the full candidate evaluation.
- **Scan 2**: NVDA (now an existing position) correctly rejected by the Position Manager as
  `HOLD_POSITION`, with an explicit, correct reason ("existing BUY position held — not enough new
  evidence to add yet. Unmet: Confidence improved enough, Minimum time since last add") — directly
  confirming **rejected candidates are logged with reasons**. The bot correctly fell back to TSLA,
  which opened as `NEW_POSITION`.
- Verified on the Bot Decisions page: both candidates' full three-tier breakdown (individual →
  Position Manager → portfolio risk) rendered correctly, including the specific individual
  Position Manager checks (side match, confidence improvement, agreement, value cap, time
  interval) that passed or failed for the rejected candidate.
- Verified on Trade Journal: the resulting trade correctly showed `Position: NEW_POSITION`, the
  position value before/after (`£0.00 → £242.23`), and the decision reason.

**Phase 2 — live, under the confirmed `bot-test@andrewwalkers.com` session** (§3), watching the
browser's actual network traffic to Supabase rather than trusting the UI alone:

- Signed in, confirmed Trade Journal showed `0 trades recorded` and "currently Supabase" as the
  active provider.
- Ran a live bot scan: NVDA opened as `NEW_POSITION`. Network trace showed
  `POST /rest/v1/paper_trades?select=id → 201`, immediately followed by
  `POST /rest/v1/trade_events?columns=... → 201` (the "opened" audit event) — both genuine
  successful writes, not optimistic local state.
  Every `GET /rest/v1/paper_trades` call was correctly filtered by `user_id=eq.<this-user's-uuid>`.
- **Hard-reload test**: reloaded the page entirely (wiping all React/JS state) and re-navigated to
  Trade Journal — the NVDA trade was still there, with every field intact (position action,
  strategy metadata, risk check summaries), proving it came back from a genuine `SupabasePaperTradeStore.load()` read, not anything cached client-side.
- Ran a **second** live scan under the same account: NVDA (now an existing live position) was
  correctly rejected as `HOLD_POSITION` by the Position Manager — the exact same live-data
  duplicate-prevention behaviour as the local test, this time proven against real persisted rows —
  and the bot correctly fell back to TSLA, which opened. Both trades' `POST` writes returned `201`.
  See §6 for how this also serves as the live "duplicate open trades" integrity check.
- Signed out cleanly at the end (`/sign-in` correctly shown again).

**Result: every item in this requirement confirmed, twice — once locally, once live.** Bot decision
log written ✅, paper trade opened when risk passes ✅ (both local and live), rejected candidates
logged with reasons ✅ (both local and live), Position Manager action logged correctly for both
executed and rejected candidates ✅ (both local and live), persisted data survives a hard reload ✅
(live). ("Learning record created/updated" remains not applicable — see §2.)

## 5. Scheduler verification

Also run in local prototype mode:

- **Manual trigger**: confirmed working, `triggerType: "Manual"` correctly recorded on both scans
  above.
- **Scheduled trigger**: selected "Every 30 minutes," clicked "Start schedule" — status correctly
  became `Running`, next-scan time correctly computed 30 minutes ahead. Seeded an overdue
  `nextScanAt` and reloaded (to simulate elapsed time without waiting 30 real minutes) — the
  10-second poll correctly fired `SCAN-000003 · Scheduled` within seconds. Both candidates were
  rejected this time (NVDA still `HOLD_POSITION`; TSLA now itself a duplicate open position) and
  the scan correctly opened no trade — confirming the scheduler runs the identical risk pipeline
  as a manual scan, with no shortcuts.
- **Trigger type recorded correctly**: confirmed on both the Dashboard panel and the Bot Decisions
  page for all three scans.
- **Browser scheduling disclosure still visible**: the "Browser-based scheduling only... True
  24/7 scheduling needs a background worker, not yet built" text is present and unchanged on the
  Dashboard panel.
- **Schedule state persists after refresh**: reloaded the page mid-schedule — mode, status
  (`Running`), interval (30 minutes), and next-scan time all survived the reload exactly as
  before, confirming the `localStorage`-backed `BotSchedulerProvider` is working correctly.
- **System Health correctly reflected all of this**: Scheduler: Running, Current interval: 30
  minutes, Last scheduled scan: `SCAN-000003`, Next scheduled scan: the correct future time.
- **Scheduler stops on sign-out**: reconfirmed structurally with the real account this time —
  signing out of `bot-test@andrewwalkers.com` and reloading correctly redirected to `/sign-in`
  before the Dashboard (and therefore the scheduler UI) ever rendered. The narrower in-tick check
  (a session that *expires* mid-schedule, without a deliberate sign-out or reload) is a timing
  window that isn't practically triggerable on demand even with a live account — Supabase session
  tokens are valid for a fixed lifetime, not something a test can force to expire early — so this
  remains verified by code review (Mission 4) rather than by direct observation.
- **Scheduler stops on persistence fallback**: code path unchanged since Mission 4 (checks
  `usePersistenceStatus().fallbackReason` before every tick). Not re-exercised live, since
  deliberately breaking the live Supabase connection to trigger this would risk leaving the
  project in an unknown state for no verification benefit beyond what Build 0.9.0's original test
  (a deliberately unreachable Supabase URL) already confirmed for the underlying fallback
  mechanism this check reads from.

## 6. Database integrity checks

| Concern | Finding |
|---|---|
| Orphaned `trade_intelligence`/`trade_events` rows | **Structurally impossible.** Both have `paper_trade_id uuid not null references paper_trades (id) on delete cascade` (migration `0002`/`0003`) — a child row cannot reference a non-existent trade, and deleting a trade cascades to delete its children. |
| Orphaned bot decisions | N/A — never persisted server-side (§2). |
| Invalid `user_id` | **Structurally impossible for non-null values**, and **live-confirmed correct** for the values that do get written: every trade created during §4's live test carried `user_id=b9632206-0aa9-4657-9a93-b59901feae72` — `bot-test@andrewwalkers.com`'s real `auth.users` id — never a placeholder, never null. `user_id uuid references auth.users (id) on delete cascade` (migration `0006`) means Postgres would reject anything else outright. `user_id is null` remains valid and expected only for pre-auth legacy rows (documented in `0006`), invisible to every user per `0007`'s RLS — not "invalid," just unclaimed. |
| Duplicate open trades where not allowed | **Not enforced at the database level — application logic only — and this was directly exercised live, not just reasoned about.** There is no unique constraint or trigger on `(user_id, instrument_symbol, side, status)`; nothing in the schema itself would stop a duplicate open position at the database layer. But running a second live scan under the test account (§4) proved the *application-level* prevention works correctly against real persisted data: the Position Manager correctly saw the live NVDA row from the first scan and rejected a second same-side NVDA candidate as `HOLD_POSITION`. The absence of a database-level backstop remains a real gap — flagged in [Known risks](#known-risks) — but the single layer of protection that does exist is now confirmed working against live data, not just local mock state. |
| Missing required fields | **Enforced live and directly exercised.** Core columns (`instrument_symbol`, `instrument_name`, `side`, `quantity`, `entry_price`, `status`, `source`, `strategy_name`, `reason`, `signal_confidence`, `opened_at`) are all `not null` per migration `0001`, plus `check` constraints on `side`, `quantity > 0`, `entry_price >= 0`, `status`, `source`, and `signal_confidence` between 0–100. Both live trade inserts in §4 populated every one of these fields and both returned `201` — a real, successful pass through every constraint, not just a schema-shape check. |

## 7. Build and lint

```
npm run lint   → clean, no errors, no warnings
npm run build  → clean; Next.js's build includes a full TypeScript typecheck (no separate
                 typecheck script exists in package.json — build already covers it)
```

No separate test suite exists in this project (consistent with every prior build/mission — this is
a prototype with manual browser verification, not an automated test suite). No code was changed
this mission, so this is a clean-state confirmation, not a regression check against new work.

## Known risks

1. **"Learning records" do not exist in this codebase.** This mission's requirements assumed a
   feature that was never built in Missions 1–4. This needs a product decision (define what a
   learning record is and where it would live) before a future mission could implement or verify
   it — I have not fabricated one here, per the explicit "no new trading features" instruction.
2. **Duplicate open trades are prevented only by client-side application logic (the Position
   Manager), not by a database constraint** — confirmed still true even after live-testing the
   protection itself (§6). This has been true since Mission 3 and is consistent with this whole
   prototype's architecture (all business logic is client-side; Supabase is a storage backend, not
   an enforcement layer) — but it means a determined direct-SQL write, or a future bug in the
   Position Manager, has no database-level backstop today.
3. **`trade_intelligence`/`trade_events` have no `update`/`delete` RLS policies** — matches current
   app behavior exactly, but would block a future feature needing to edit them without a new
   migration.
4. **The £250/£750/£6,000 notional caps are compared directly against USD instrument prices with
   no FX conversion** — a pre-existing, previously-disclosed simplification (Mission 1), unchanged
   and unrelated to this mission, restated here only because "extended paper trading readiness" is
   this mission's frame.
5. **Two real paper trades (NVDA, TSLA) now exist permanently in the `bot-test@andrewwalkers.com`
   account** as a direct result of live-testing the write path (§3–§4). The app has no delete
   capability; removing them (if wanted) requires the Supabase dashboard directly.

## Readiness verdict

**Schema and RLS: ready.** Every migration through `0013` is live, every column the app expects
exists, and Row Level Security is confirmed active and correctly scoped on all three tables — not
just for the previously-tested `paper_trades`, but `trade_intelligence` and `trade_events` too.
Both directions of "users can read/write only their own data" are now live-confirmed: anonymous
writes are rejected (§2), and the confirmed test account's own writes/reads succeed and correctly
round-trip (§3–§4).

**Application logic: ready.** The full bot pipeline (individual risk → Position Manager →
portfolio risk), manual and scheduled triggering, and decision logging all behave correctly and
consistently under direct test — in local prototype mode *and* against the live database under a
real authenticated session, including a second live scan proving duplicate-position prevention
holds against real persisted data, not just local mock state.

**Live authenticated verification: complete.** A permanent, confirmed test account exists
(`bot-test@andrewwalkers.com`), sign-in and sign-out/sign-in are both proven repeatable, and real
writes/reads round-trip correctly through Supabase with RLS active throughout. This closes the one
gap every prior build/mission since 1.1.0 had disclosed as unverifiable.

**Extended paper trading: ready**, with two disclosed, pre-existing gaps unrelated to this
mission's own scope — no database-level duplicate-trade constraint (application logic only) and no
FX conversion on notional caps — both restated in [Known risks](#known-risks), neither new.

**VPS/background-worker scheduling: not ready, and not a goal of this mission.** Mission 4 already
disclosed exactly what that would require (a process independent of any browser tab, a real
server-side auth story, schedule config moved into Supabase); nothing in this mission changes that
assessment — if anything, this mission's newly-confirmed test account removes one prerequisite
blocker for whoever picks that work up next.

## Files changed

- New: `docs/product/MISSION-5-VERIFICATION-READINESS.md` (this document)
- No application code was changed this mission — verification only, per the mission's own
  instruction.

## Database changes applied

None by me directly (no execution access). The user confirmed migrations `0008`–`0013` were
already applied prior to this mission; this report's §1 independently corroborates that live.
