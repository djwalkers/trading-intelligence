# Build 0.1.1 — UI Refinement Pass

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md)

## What was built

A refinement pass on top of Build 0.1.0. No new pages, data, or features — this build only
improves the existing prototype's UI and layout.

- Reduced sidebar navigation icon size for a calmer, more balanced feel (24px → 14px, with
  matching tighter row padding).
- Added a compact logo/title area in the sidebar using the temporary product name **Trading
  Intelligence**.
- Improved responsive layout for smaller laptop screens: the dashboard's four-column stat grid
  and the two-column signals/system-health layout now activate at the `lg` breakpoint (1024px)
  instead of `xl` (1280px), and the sidebar is narrower below `xl` so more room goes to content.
- Added a clear **Build 0.1.1** label to the System Health page (page description and a
  dedicated badge, replacing the generic "Prototype build" badge).
- Added a "Prototype mode" banner across the top of the app, distinct from the existing "Paper
  Trading" badge, so the build's overall status is visible on every page.
- Tightened table and list row spacing (signals, watchlist, positions, strategies, system health)
  so dense data reads as calm and premium rather than oversized.
- Added a lightweight footer on every page showing `Trading Intelligence · Build 0.1.1` and
  `Mock data · Paper trading only`.

## What is intentionally not included yet

Unchanged from Build 0.1.0: no authentication, no database or persistence layer, no real broker
or market data connection, no AI-generated signals, no live order execution, no financial advice
language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `http://localhost:3000`. `npm run lint` and `npm run build` both pass cleanly on this build.

## Next recommended build

Unchanged from 0.1.0: **Build 0.2.0** should introduce a persistence layer (Supabase) behind the
existing type contracts in `src/lib/types`, replacing in-memory mock data with a thin data-access
layer while keeping the UI contract stable.
