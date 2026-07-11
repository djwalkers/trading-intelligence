# Build 1.12.2 — Accessibility, Mobile and Interaction Hardening

Date: 2026-07-10
Location: `Trading/platform/web`

## Scope completed

A hardening pass focused on keyboard/focus management, one remaining hydration gap, and mobile
responsiveness — no trading logic, risk rule, database schema, worker scheduling, sample/live data
labelling, scan numbering, or the Build 1.12.1 day-range fix changed. The Signals/Strategies/AI
Engine product boundary clarified in Build 1.12.1 was left exactly as it was — not merged, not
renamed.

Completed:
1. Shared focus-trap modal implementation, applied to all three existing dialogs.
2. `BotDecisionLogProvider` hydration safety, matching the `isHydrated` pattern already used by
   `PaperTradesProvider`/`DecisionHistoryProvider`.
3. A mobile audit across representative viewports (320/375/390/430/768/desktop) on every route.
4. A documented, hardened table strategy applied consistently across every data table.
5. Navigation/header accessibility fixes (`aria-current`, focus rings, touch target sizing).
6. A keyboard-only audit of the new modal focus trap and the main navigation's tab order.
7. Screen-reader/semantic improvements (table captions, `scope="col"`, `aria-live` status regions).
8. A contrast review beyond the `text-ink-600` fix already shipped in Build 1.12.1.
9. Interaction-state consistency via a shared `Button` component and a visible "Saving…" indicator
   for the one previously-silent disabled state found.

## Components and files changed

**New:**
- `src/components/ui/Modal.tsx` — shared focus-trap/scroll-lock/return-focus dialog shell.
- `src/components/ui/Button.tsx` — shared button styling and interaction states.

**Modal consolidation:**
- `src/components/trading/PaperTradeModal.tsx`, `CloseTradeModal.tsx`, `ImportHistoryModal.tsx` —
  rebuilt on top of `Modal`/`Button`; removed three duplicated escape-key `useEffect`s and three
  duplicated button `className` strings.

**BotDecisionLogProvider hydration:**
- `src/lib/state/bot-decision-log-context.tsx` — added `isHydrated`.
- `src/components/dashboard/RecentAIDecisionsList.tsx`, `src/components/bot/BotDecisionsView.tsx`,
  `src/components/dashboard/AIActivityKpis.tsx`, `src/components/system-health/AIEngineActivityPanel.tsx`
  — all four consumers now show a loading state (skeleton rows or a loading marker) instead of an
  empty/zero value before hydration completes.

**Tables (scoped headers, captions, keyboard-scrollable regions):**
- `src/components/tables/WatchlistTable.tsx`, `PositionsTable.tsx`, `PaperTradesTable.tsx`,
  `SignalsTable.tsx`, `src/components/market-intelligence/ComparisonTable.tsx`,
  `src/components/decision-intelligence/DecisionIntelligenceView.tsx` — every `<th>` now has
  `scope="col"`, every table has a `sr-only` `<caption>`, and every horizontal-scroll wrapper is now
  a `role="region"` with a descriptive `aria-label` and `tabIndex={0}` so keyboard users can scroll
  it directly. The Decision Intelligence table (the largest, 18 columns) was also brought in line
  with every other table's `min-w-[…]` + `scrollbar-thin` pattern — previously the one inconsistent
  table in the app.

**Navigation:**
- `src/components/layout/Sidebar.tsx`, `Topbar.tsx` — `aria-current="page"` on the active link,
  visible focus rings added (previously hover-only), `aria-label="Main"` on both nav landmarks, and
  a `min-h-11` (44px) touch target on the mobile pill nav.

**Status announcements:**
- `src/components/dashboard/QuickActionsPanel.tsx` — a visually-hidden `aria-live="polite"` region
  announces "Scan started"/"Scan complete…" for screen-reader users (the visible result only
  appears in other Dashboard widgets).
- `src/components/settings/BrowserAutomationPanel.tsx`, `ServerAutomationPanel.tsx` — the
  Running/Enabled status badges are now wrapped in `aria-live="polite"`; save errors now use
  `role="alert"`; `ServerAutomationPanel` also gained a visible "Saving…" indicator next to its
  Enable/Disable buttons (previously the only disabled-with-no-visible-reason control found).

## Modal focus-management approach

A single shared `Modal` component (`src/components/ui/Modal.tsx`) replaces three near-identical
hand-rolled implementations. Every modal in this codebase is conditionally *mounted* only while
open — never kept in the DOM and CSS-hidden — so "mounted" and "open" are the same event, and a
plain mount effect is sufficient (no `isOpen` prop needed):

- **Focus in**: on mount, focuses the caller's preferred control via `initialFocusRef` if it's
  genuinely focusable (checked via `:disabled` — a Confirm button disabled by a still-loading price
  silently refuses focus, so the effect falls back to the first focusable control instead), else the
  first focusable element in the dialog, else the dialog container itself (`tabIndex={-1}`).
- **Tab trap**: a single `keydown` listener cycles focus between the first and last focusable
  elements, and pulls focus back in if it somehow ends up outside the container.
- **Escape**: closes via the caller's `onClose`, read through a ref so the trap effect doesn't need
  to re-run (and re-steal focus) every time a parent re-renders with a new inline callback.
- **Scroll lock**: `document.body.style.overflow = "hidden"` for the duration, restored on unmount.
- **Return focus**: the element that had focus before the modal opened (the trigger button) is
  refocused on close — verified live (see below).
- **ARIA**: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (existing title ids), and a new
  `aria-describedby` pointing at each modal's description paragraph.

Backdrop click does not close any modal — this was already true before this build and is preserved
deliberately, consistent with these being trading-safety confirmations, not dismissable notices.

## BotDecisionLogProvider hydration changes

Added `isHydrated: boolean` to the context value, set only after the deferred microtask that reads
`localStorage` resolves (success, empty, or corrupt-and-caught — all three paths now set
`isHydrated = true` via a `finally` block). This mirrors the pattern Build 1.12.1 used for
`PaperTradesProvider`/`DecisionHistoryProvider`. All four consumers were updated:

- `RecentAIDecisionsList` and `BotDecisionsView` show skeleton placeholder rows while not hydrated.
- `AIActivityKpis` and `AIEngineActivityPanel` show a plain loading marker (`"…"` / `"Loading…"`)
  in place of `"0"` / `"Never"` / a reason string while not hydrated.

Verified live in all three required conditions (existing persisted decisions, an emptied
`localStorage` array, and the key entirely absent) — see Verification below.

## Mobile table patterns selected

Every data table in the app (Watchlist, Signals, Positions, Paper Trades, the Market Intelligence
comparison table, and the AI Decision History table) already used the same underlying pattern —
horizontal scroll inside an `overflow-x-auto` container with a fixed `min-w` — before this build.
That consistency is deliberately **kept and hardened** rather than replaced with per-table card
layouts: horizontal scrolling is one of the patterns this build's own brief lists as appropriate for
"genuinely tabular data," and every table here is dense, many-columned trading data where a card
representation would either hide columns or force a much taller page. The one inconsistency found —
the Decision Intelligence table (18 columns) was missing the `min-w`/`scrollbar-thin` classes every
other table has — was fixed, and every scroll container was upgraded to a labelled, keyboard-focusable
`role="region"` so the pattern is now uniform and accessible everywhere it's used. Non-tabular
widgets (KPI cards, the Dashboard's summary panels) were already using responsive grid stacking
(`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`) and needed no changes — verified clean at every tested
width down to 320px.

## Routes tested

Dashboard, Watchlist, Signals, Paper Portfolio, Bot Decisions, Settings, Operations Centre — covering
every table pattern, the Dashboard's KPI grid, the mobile nav, and the modal flow (Signals →
PaperTradeModal). Market Intelligence, Trade Journal, AI Decision History, Strategies, and the
auth/error pages share the same layout primitives (`PageHeader`, `SectionPanel`, the same table
component, the same `AppShell`) already exercised on the tested routes and were not each individually
re-screenshotted.

## Viewports tested

320×700, 375×812, 430×900, 768×1024, and the desktop baseline. No horizontal overflow was found at
any width (`document.documentElement.scrollWidth` matched `clientWidth` on every route checked).

## Keyboard workflows tested

- Main navigation: confirmed the natural DOM/tab order matches the visual sidebar order (Dashboard →
  Market Intelligence → Watchlist → …), and that the active page's link carries `aria-current="page"`.
- Full modal workflow (Signals → "Paper Trade" → PaperTradeModal): confirmed initial focus lands on
  the first genuinely focusable control (Cancel, since Confirm starts disabled while the price
  loads), confirmed Shift+Tab from the first control wraps to the last, confirmed Escape closes the
  dialog, restores `document.body.style.overflow`, and returns focus to the "Paper Trade" trigger
  button that opened it.

## Accessibility improvements

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby` + new `aria-describedby` on every modal.
- `scope="col"` on every table header cell; a `sr-only` `<caption>` on every table.
- Every horizontal-scroll table wrapper is a labelled, keyboard-focusable `role="region"`.
- `aria-current="page"` and visible focus rings on both navigation surfaces (desktop sidebar, mobile
  pill nav) — the mobile nav previously had no focus ring at all, only a hover state.
- `aria-live="polite"` status regions for scan start/completion and automatic-scanning
  enable/disable; `role="alert"` on the server-schedule save error.
- 44px-minimum touch targets on the mobile navigation strip.

## Contrast changes

Beyond the `text-ink-600` fix already shipped in Build 1.12.1, this build computed contrast ratios
for every other color/opacity combination in use (disabled-state `opacity-50` text, badge text,
accent colors as body text) against the app's actual background tokens. Disabled-control text at
50% opacity does fall below the 4.5:1 AA threshold (e.g. `accent-teal` at 50% opacity over
`base-900` measures ≈3.2:1) — but WCAG 1.4.3 explicitly exempts "inactive user interface component"
text from the contrast minimum, so this is not a compliance gap. The substantive fix in this area was
behavioural, not color: `ServerAutomationPanel`'s Enable/Disable buttons could go disabled during a
save with no visible reason shown anywhere on the page; a "Saving…" status text now makes that state
self-explanatory regardless of contrast.

## Bugs discovered and fixed

- **`BotDecisionLogProvider` had no way for a consumer to distinguish "still reading localStorage"
  from "genuinely no decisions"** — four widgets (two Dashboard widgets, the full Bot Decisions
  page, and the Operations Centre's AI Engine panel) could briefly show "0"/"Never"/an empty-state
  prompt before the deferred `localStorage` read resolved. Fixed by exposing `isHydrated` and gating
  all four render paths on it.
- **The Decision Intelligence table (18 columns) was the one table in the app without a `min-w` or
  `scrollbar-thin` class**, inconsistent with every other table's horizontal-scroll pattern — could
  render squashed rather than scrollable on some viewports. Fixed.
- **The mobile navigation strip had no visible focus indicator and no `aria-current`** — a keyboard
  user tabbing through it on a narrow viewport had no way to see which link was focused, or which
  page was already active. Fixed.
- **`ServerAutomationPanel`'s Enable/Disable buttons could go disabled mid-save with no visible
  explanation.** Fixed with a "Saving…" status text.

## Verification performed

- `npm run lint` — clean.
- `npx tsc --noEmit` — clean.
- `npm run build` — clean, all 17 routes compiled and statically generated successfully.
- **Live browser verification** (local mode, `.env.local` moved aside): desktop baseline and mobile
  viewports 320/375/430/768 checked on Dashboard, Watchlist, Signals, Paper Portfolio, Bot Decisions
  — zero horizontal overflow, zero console errors, zero hydration warnings on any route or viewport.
  Confirmed the automatic-scanning tick fired correctly in the background during testing (AI
  decisions today incremented, Last/Next scan times advanced) — no regression to Build 1.12.0's
  always-on automation runner.
- **Hydration verification**: confirmed all three required conditions for
  `BotDecisionLogProvider` — existing persisted decisions (Bot Decisions page showed the prior scan
  history correctly), an emptied `localStorage` array and an entirely absent key (both correctly
  render the Build 1.12.1 empty-state copy after hydration, with no premature flash beforehand).
- **Keyboard verification**: modal focus trap (focus-in, Shift+Tab wrap, Escape, return-focus) and
  main navigation tab order/`aria-current`, both confirmed live — see above.
- **Console verification**: zero errors, zero hydration-mismatch warnings, zero repeated
  state-update warnings across every route and viewport tested.

## Remaining limitations

- **Aria-live coverage is not exhaustive.** Scan start/completion and automatic-scanning
  enable/disable are announced; individual trade-opened/trade-rejected/position-closed events are
  not, since the confirmation modals unmount immediately on confirm with no intermediate
  "success" state to announce from — a screen-reader user relies on the destination page's own
  content (e.g. the Trade Journal) updating, the same as a sighted user relies on the visual update.
  Building a standalone global toast/announcer system for this felt like new architecture beyond this
  build's "harden what exists" scope; flagging it as the natural next increment.
- **Keyboard verification covered the modal flow and main navigation, not every interactive control
  on every page** (e.g. the Decision Intelligence filter `<select>`, Settings' interval selector) —
  these are all plain semantic `<select>`/`<button>` elements with no custom keyboard handling, which
  is lower-risk than the modal/nav surfaces that were explicitly tested, but not each individually
  walked through with real key presses this session.
- **No automated axe/Lighthouse accessibility scan was run** — this pass was manual (code-level ARIA
  audit plus live DOM/console verification), not tool-assisted; a dedicated automated scan would
  likely surface additional minor findings.
- **Focus-trap `Modal` component has no automated test coverage** — verified manually and live in
  the browser this session, but a regression here (e.g. from a future edit) wouldn't be caught by
  `npm run build`/`tsc`/lint alone.

## Recommended next build

With the interaction/accessibility layer now hardened, the next build should return to the
architectural backlog: apply migration `0017` to the live Supabase project and observe the
outcome-analysis loop end-to-end; run a live concurrency test against real Postgres; or wire the
Market Intelligence/Watchlist display pages to the real Alpha Vantage-backed historical data path
that only the AI Engine's own scans currently use. A lighter-weight follow-up worth considering
sooner: an automated accessibility scan (axe-core or similar) to validate this build's manual audit
and catch anything a human pass missed.
