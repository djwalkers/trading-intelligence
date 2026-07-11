# Build 1.13.0 — Production Readiness and Operational Hardening

Date: 2026-07-10
Location: `Trading/platform/web`

## Scope completed

All 20 sections of the build brief were addressed. No trading calculation, strategy definition,
risk threshold, Position Manager rule, portfolio risk rule, scan frequency rule, fallback candidate
selection, sample quote generation, starting portfolio holdings, day-range calculation, or existing
terminology changed — this build adds observability and safety nets around the existing system, it
does not alter what the system decides or does.

1. Central, validated environment configuration (`src/lib/config/`).
2. A shared `AppError` normalisation layer used at every important boundary.
3. A small `HealthStatus` model + a production-safe `/api/health` endpoint.
4. A lightweight toast notification system covering every required event.
5. Route-segment and root error boundaries (`error.tsx`, `global-error.tsx`).
6. A structured logger, applied to every existing meaningful `console.error` call site.
7. A persistence diagnostics audit across all six localStorage-backed stores, with concrete
   safe-write fixes where a real gap was found.
8. A single source of truth for the app version (`src/lib/version.ts`, derived from
   `package.json`), fixing two UI locations that had drifted to a stale "Build 1.12.0".
9. A Vitest + Testing Library + axe-core test suite (39 tests) — config validation, error
   normalisation, the health endpoint, hydration behaviour, the modal focus trap, and an automated
   accessibility scan.
10. A PM2 `ecosystem.config.js` for both the web process and the worker process.
11. `docs/operations/DEPLOYMENT.md` and `docs/operations/RUNBOOK.md`.

## Architecture changes

New modules, none of which change existing behaviour except where explicitly noted:

- `src/lib/config/env.ts`, `client-config.ts`, `server-config.ts` — validated configuration layer.
- `src/lib/logger/logger.ts` — structured logging (debug/info/warn/error).
- `src/lib/errors/app-error.ts` — `AppError` class + `toAppError()` normaliser.
- `src/lib/health/health-status.ts`, `get-application-health.ts` — the health model.
- `src/app/api/health/route.ts` — the health endpoint.
- `src/lib/notifications/toast-bus.ts`, `use-toast.ts`, `src/components/ui/ToastViewport.tsx` — the
  notification system.
- `src/app/error.tsx`, `src/app/global-error.tsx` — error boundaries (new; didn't exist before).
- `src/lib/persistence/safe-local-storage.ts` — shared safe-write helpers.
- `src/lib/version.ts` — single-source app version.
- `ecosystem.config.js` — PM2 process definitions.
- `vitest.config.ts`, `vitest.setup.ts`, `tests/` — the test suite.

Existing modules were updated to *use* the above (config, logger, error normalisation) rather than
rewritten — see "Files changed" for the full list.

## Environment variables added or changed

No new required variables. One new optional variable's validation was tightened:

| Variable | Change |
|---|---|
| `WORKER_POLL_INTERVAL_MS` | Now parsed and validated (positive integer, min 1000) via the config layer instead of `Number(x ?? 30000)`, which silently produced `NaN` for a malformed value. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No change in what's required — still both optional — but now validated as a pair: one set without the other throws a clear `ConfigError` at startup instead of silently behaving as fully unconfigured. |
| `NEXT_PUBLIC_MARKET_DATA_PROVIDER` / `NEXT_PUBLIC_MARKET_DATA_API_KEY` | Same pairing validation. |
| `SUPABASE_SERVICE_ROLE_KEY` | Now validated against `NEXT_PUBLIC_SUPABASE_URL` as a pair (a service-role key with no URL to connect to is always a mistake). |

Every variable's required/optional and server-only/client-safe status is documented in
`.env.example`'s new header summary and in the table above.

## Error-handling approach

`AppError` (`src/lib/errors/app-error.ts`) carries a stable `code` (`CONFIGURATION_ERROR` |
`PERSISTENCE_ERROR` | `MARKET_DATA_ERROR` | `AUTOMATION_ERROR` | `TRADE_EXECUTION_ERROR` |
`UNKNOWN_ERROR`), a safe `userMessage`, a `diagnosticMessage` for logs only, whether the failure is
`retryable`, and the original `cause`. `toAppError()` normalises any thrown value into this shape.
Applied at:

- **Bot scans** (`use-bot-scan-runner.ts`): `runScan()` previously had no top-level try/catch at
  all — a scan failure was an **uncaught promise rejection** (`AutomationRunner`'s scheduled tick
  calls `runScan()` without awaiting or catching it). Now every path resolves; failures log via
  `toAppError` + the structured logger and show an error toast; the caller checks for `null`.
- **Trade opening / closing** (`paper-trades-context.tsx`): write failures are logged and surface a
  one-time "may not be saved" warning toast, distinct from an expected `AuthRequiredError` (which
  already has its own handling via `AuthGate`).
- **Persistence writes**: see "Persistence diagnostics" below.
- **Automation configuration** (`ServerAutomationPanel`): save failures already set `actionError`
  state; now also log and toast.
- **Health checks**: `getApplicationHealth()` catches `ConfigError` internally and reports
  `"degraded"` rather than throwing out of the route handler; the route handler itself has a final
  catch-all returning a safe `503` shape.
- **Configuration startup**: `client-config.ts`/`server-config.ts` throw `ConfigError` (a
  `toAppError`-compatible shape) for genuinely invalid configuration.

## Notification architecture

A plain module-level external store (`src/lib/notifications/toast-bus.ts`), not a React Context —
deliberately, because persistence failures need to be reportable from plain TypeScript modules
(the resilient stores) that aren't components and can't call `useContext`. `pushToast(category,
message)` is the single write path, used identically by components (via the thin `useToast()`
hook) and by non-component code (direct import). `ToastViewport` (mounted once in `AppShell`)
subscribes via `useSyncExternalStore` — SSR-safe, no hydration-mismatch risk.

- Categories: success / info / warning / error, colour-coded with the app's existing accent tokens.
- Accessibility: the viewport is `aria-live="polite"`; each error-category toast additionally
  carries `role="alert"` (implicitly assertive, regardless of the container).
- Behaviour: capped at 4 visible toasts (oldest dropped), each auto-dismisses after 6 seconds, each
  has an explicit "Dismiss" button, positioned bottom-center on mobile / bottom-right on desktop so
  it never overlaps the Topbar's mobile nav strip (which is fixed to the *top*).
- Strict Mode safety: every `pushToast` call site fires from a user-initiated callback or a promise
  resolution, never from a bare render-phase `useEffect`, so React 18's dev-mode double-invoke of
  effects cannot produce a duplicate toast.
- Events covered: trade opened, position closed, scan started, scan completed (folded together
  with "trade rejected" — see below), scan failed, automation enabled, automation disabled,
  automation save failed, settings saved, persistence failure (deduplicated to once per store per
  session via `pushToastOnce`). "Data reset" has no toast because no reset/clear feature exists
  anywhere in the app to instrument (confirmed during the persistence audit).
- **Scoping decision on "trade rejected"**: a single scan can reject several candidates; per-candidate
  toasts would violate "avoid stacking without limit." Rejection is instead folded into the
  "scan complete" toast ("Scan complete — no trade opened: `<reason>`"), which already conveys the
  outcome without per-candidate noise.

## Health model

`HealthStatus = "healthy" | "degraded" | "unavailable" | "unknown"` (`src/lib/health/health-status.ts`,
meanings documented in code comments and reproduced here):

- **healthy** — configured (or deliberately unconfigured with a working fallback), no known problem.
- **degraded** — configured incompletely or inconsistently; will likely misbehave until fixed.
- **unavailable** — cannot function right now.
- **unknown** — this process has no reliable way to know (e.g. the separate VPS worker's actual
  process state) — never reported as "healthy" merely because nothing is known to be wrong.

`getApplicationHealth()` computes this from **configuration presence**, not a live network probe —
deliberately, to keep the endpoint fast, side-effect-free, and safe for frequent polling. `automation`
is always `"unknown"`, consistent with `VPSWorkerStatusPanel`'s existing honest disclosure that this
Next.js process has no channel to the separate worker process.

### Health endpoint response

`GET /api/health`, verified live in local mode:

```json
{
  "status": "healthy",
  "version": "1.13.0",
  "timestamp": "2026-07-10T22:32:20.330Z",
  "services": {
    "application": "healthy",
    "persistence": "healthy",
    "marketData": "healthy",
    "automation": "unknown"
  },
  "dataMode": "Sample data"
}
```

Returns `200` for healthy/degraded/unknown-overall, `503` only when overall status is
`"unavailable"`. Never includes credentials, stack traces, file paths, or process identifiers —
verified both by code review and by a test asserting the response never matches
`SERVICE_ROLE`/`API_KEY`/a stack-trace shape.

## Logging approach

`src/lib/logger/logger.ts` — `debug`/`info`/`warn`/`error`, each accepting a structured `LogContext`
(component, scanId, triggerType, instrument, strategyId, outcome, errorCode, plus free-form safe
fields). Development output stays verbose and readable (bracket-tagged, multi-arg `console.*`
calls, preserving this codebase's existing `[component]` convention); production output collapses
`debug` entirely and emits `info`/`warn`/`error` as single-line JSON (grep/aggregator-friendly).
Applied to the 6 existing meaningful `console.error` call sites (the resilient stores' fallback
events, the Alpha Vantage cache-write failure, the decision-history outcome-update failure) — not a
mechanical replace-everything pass. The worker's own `src/worker/logger.ts` (a purpose-built,
16-event closed union already designed for VPS log-grepping) was deliberately left untouched — it
already satisfies this build's spirit, and rewriting its exact output format risked breaking any
existing grep-based monitoring against its documented event names.

## Persistence diagnostics

All 6 localStorage-backed stores audited:

| Store | Key | Version | Malformed JSON | Missing key | Migration | Write failure (before) | Write failure (after) |
|---|---|---|---|---|---|---|---|
| Paper trades | `trading-intelligence.paper-trades.v1` | v1 | Caught, falls back to `[]` | Caught, falls back to `[]` | `normalizeTrade()` backfills pre-0.4.0 records missing `source` | **Unguarded `setItem`** | Now throws a clean error via `setItemOrThrow`, correctly caught by `paper-trades-context.tsx`'s existing `.catch()` (logs + one-time toast) |
| Bot decisions | `trading-intelligence.bot-decisions.v5` | v5 (bumped v1→v5, old entries never migrated — a local log, not an audit trail) | Caught, empty log | Caught, empty log | None (deliberate) | **Unguarded `setItem`**, inside a `setState` updater | Now `setItemSafely` (logs, returns boolean, never throws — throwing inside a setState updater would crash the render) |
| Decision history | `trading-intelligence.decision-history.v1` | v1 | Caught, empty history | Caught, empty history | None | **Unguarded `setItem`** (×2) | Now `setItemOrThrow`, caught by `decision-history-context.tsx`'s `addRecords` (now logs instead of a bare empty catch) |
| Bot scheduler | `trading-intelligence.bot-scheduler.v1` | v1 | Caught, default state | Caught, default state | None | **Unguarded `setItem`**, inside a `setState` updater | Now `setItemSafely` (logs only, same reasoning as bot decisions) |
| First-run import flag | `trading-intelligence.import-prompt-resolved.v1` | v1 | N/A (plain string flag) | Treated as unresolved | None | N/A (no JSON write) | Unchanged |
| Scan-id counter | `trading-intelligence.bot-scan-counter.v1` | v1 | Already guarded | Already guarded (defaults to 0) | None | Already guarded (silently continues, documented as intentional) | Unchanged — already correct |

Every store's hydration is SSR-safe (`typeof window === "undefined"` guards) and defers its state
update into a microtask to avoid a hydration mismatch — an existing, correct pattern this build
preserved everywhere. No corrupted or old-version data is ever cleared automatically; malformed JSON
always falls back to an empty/default in-memory state without touching what's on disk.

## Automated tests added

`vitest.config.ts` + `tests/` (39 tests, 8 files) — see "Accessibility scan results" for the a11y
suite specifically. Vitest was chosen over Playwright: this sandboxed environment cannot reliably
download a real browser binary, and Vitest + jsdom + Testing Library + axe-core needs none — a
`server-only` package resolution alias (`tests/stubs/server-only.ts`) lets server-only modules be
unit tested directly, mirroring what Next's own `"react-server"` build condition does internally.

- `tests/config/env.test.ts`, `client-config.test.ts`, `server-config.test.ts` — parsing/validation
  primitives and both config modules, including every "half-set pair throws" case.
- `tests/errors/app-error.test.ts` — `toAppError()` normalisation, including passthrough and safe
  message override.
- `tests/health/health-route.test.ts` — imports the route handler directly, asserts the documented
  shape, the correct HTTP status, and that no secret-shaped or stack-trace-shaped text ever appears.
- `tests/components/bot-decisions-hydration.test.tsx` — the exact scenario Build 1.12.2's
  `isHydrated` exists for: existing persisted decisions render correctly; an absent key renders the
  empty state only after hydration completes, never before.
- `tests/components/modal-focus-trap.test.tsx` — real keyboard simulation (`@testing-library/user-event`):
  initial focus, Tab-wrap, Escape-to-close, and return-focus-to-trigger.

## Accessibility scan results

**Tool**: axe-core, run directly against jsdom-rendered output (`tests/accessibility/axe-scan.test.tsx`,
`axe-helper.ts`) — not a real browser. **Routes covered** (component-level, not full-page): Bot
Runner/Bot Decisions (`BotDecisionsView`), Settings (`BrowserAutomationPanel`), Paper Portfolio
(`PortfolioView`), an open `Modal` dialog, and `ToastViewport` with an active notification. **How to
run**: `npm test` (or `npx vitest run tests/accessibility/`). **Result**: zero violations across all
five cases.

**Known limitations** (documented per the build brief's explicit request):
- The `color-contrast` rule is disabled — jsdom does no layout/paint, so this rule can't run
  meaningfully there; Build 1.12.2's manual, real-browser contrast audit is the actual coverage for
  contrast, not this automated scan.
- Dashboard, Watchlist, and AI Decision History were not each individually rendered — they share
  the same `PageHeader`/`SectionPanel`/table primitives already exercised by the covered routes, but
  were not separately re-tested here.
- This is component-level rendering, not full Next.js route-level (server components, real routing,
  and real CSS layout are not exercised) — a genuine E2E browser suite (Playwright) would close this
  gap; not attempted here due to this sandboxed environment's inability to reliably install a
  Chromium binary.
- This automated scan does not replace manual keyboard testing — the modal focus-trap test above
  uses real simulated keyboard events specifically because axe-core cannot verify *interactive*
  keyboard behaviour, only static ARIA/semantic structure.

## Security review findings

Checked: browser console, the health endpoint's response body, error page content, toast messages,
the `/api/health` API response, and the production build output.

- **No credentials, tokens, or secrets found in any of the above.** `ALPHA_VANTAGE_API_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` remain behind `import "server-only"` (enforced at build time — the
  build fails if a client component ever imports either module, even transitively); neither is
  `NEXT_PUBLIC_`-prefixed, so Next.js never inlines them into the client bundle.
- **Error pages never render raw exception text.** `error.tsx`/`global-error.tsx` show only a fixed,
  safe message plus a reference id (`error.digest`, Next's own built-in mechanism, or a
  client-generated fallback) — never `error.message` or a stack trace.
- **The health endpoint never exposes secrets, process identifiers, or file paths** — verified by a
  test that greps the JSON response for secret-shaped and stack-trace-shaped substrings.
- **Toast notifications never include raw exception text** — every `notify()`/`pushToast()` call
  site passes a hand-written safe string, never `error.message` directly.
- **Source maps**: this project uses Next.js's default production settings, which do not upload or
  expose source maps to the client by default; no explicit `productionBrowserSourceMaps: true` is
  set anywhere. No change was made here since the default is already the safe one — documented as a
  "leave as-is" finding, not a fix.
- **Not claimed**: this is a targeted review of the specific surfaces listed in the build brief, not
  a penetration test.

## Deployment documentation delivered

- `docs/operations/DEPLOYMENT.md` — prerequisites, environment configuration, build/start/worker
  commands, PM2 (`ecosystem.config.js`, new this build), health endpoint usage, restart/rollback,
  log inspection, a production verification checklist.
- `docs/operations/RUNBOOK.md` — practical symptom → cause → check → action steps for the 13
  scenarios the build brief lists.

## Verification commands and results

```bash
npm run lint        # clean
npx tsc --noEmit     # clean
npm run build        # clean — 18 routes, including the new /api/health (dynamic)
npm test             # 39/39 passing (8 test files)
```

Live browser verification (local mode, `.env.local` moved aside): `/api/health` returns the exact
documented shape; Dashboard, Watchlist, Bot Decisions, Decision Intelligence, Paper Portfolio, Trade
Journal, Settings, Operations Centre, the 404 page, and a deliberately-triggered error state (a
temporary `throw` added to and immediately removed from `strategies/page.tsx`) all verified with
zero console errors and no hydration warnings; toast notifications observed live from both the
automatic-scanning tick and a manual "Run scan now" click; the error boundary correctly isolated the
failing route (sidebar/navigation remained fully usable) and showed a real Next.js `error.digest`
reference id; the version string (`Build 1.13.0`) renders consistently in the Sidebar, Footer, and
the health endpoint; no horizontal overflow at 375px mobile width.

## Remaining limitations

- **Aria-live coverage for individual trade-opened/rejected events remains as disclosed in Build
  1.12.2** — this build added toasts for trade-opened/closed at the context layer, but a full
  per-candidate rejection announcement system was deliberately not built (see "Notification
  architecture" scoping decision above).
- **The accessibility scan is component-level (jsdom), not full-browser E2E** — see "Known
  limitations" above. A Playwright + axe-core suite would be a natural upgrade once a real browser
  binary is available in the CI/deployment environment.
- **The health endpoint reports configuration presence, not live connectivity** — it cannot
  currently tell you whether Supabase is actually reachable right now, only whether it's validly
  configured. A live-ping variant was deliberately avoided to keep the endpoint fast and
  side-effect-free for frequent external polling; if genuine live-connectivity health becomes
  necessary, it should be a separate, more expensive check, not folded into this endpoint.
- **`ecosystem.config.js` has not been run against a real VPS** — written and documented, but (like
  the worker itself since Mission 8) not yet exercised in a real deployment with a process
  supervisor.
- **No automated smoke test exercises full page-level SSR** (only component-level rendering) — see
  the accessibility section's limitations, which apply equally to the smoke tests.

## Recommended next build

With configuration, error handling, health, logging, and notifications now hardened, the next build
should either (1) exercise this build's new deployment tooling for real — provision a VPS, run
`ecosystem.config.js` under actual PM2, and validate the Runbook's procedures against a genuine
failure; or (2) return to the architectural backlog flagged since Build 1.12.2: apply migration
`0017` to a live Supabase project, run a live concurrency test, or wire the Market
Intelligence/Watchlist display pages to the real historical data path the AI Engine's own scans
already use.
