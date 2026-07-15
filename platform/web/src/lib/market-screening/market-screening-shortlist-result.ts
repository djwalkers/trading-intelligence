import type { Instrument } from "@/lib/types";

// Sprint 294 §5 — when market screening cannot produce a shortlist (today: always, since no
// provider is configured and the rollout stage defaults to "off"), the worker falls back to
// exactly the existing static instrument list. This type makes that fallback explicit and
// traceable, rather than an implicit side effect a caller has to infer.
export type MarketScreeningShortlistResult =
  | { source: "market-screening"; instruments: Instrument[] }
  | { source: "fallback-static-list"; instruments: Instrument[]; reason: string };
