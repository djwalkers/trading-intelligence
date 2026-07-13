import type { DataProvenance } from "@/lib/types";

// Sprint 290 — shared helpers so production reporting and any future Hermes training
// automatically exclude sample_data and fallback_sample_data unless a caller explicitly opts in,
// rather than each new reporting surface reimplementing its own provenance filter (and risking one
// that forgets a case). Two distinct, separately-named helpers rather than one configurable one:
// "verified live data" and "learning eligible" are genuinely different questions with different
// default answers for backtest — see each function's own comment.

// A record only counts as verified live data when every material data touchpoint that produced it
// was external — backtest is deliberately excluded here too, even though it isn't sample data
// either: it's still not LIVE production signal, so default production reporting must not treat it
// as such unless a caller explicitly asks for backtest data by some other means.
export function isVerifiedLiveData(provenance: DataProvenance): boolean {
  return provenance === "verified_external_data";
}

export function filterToVerifiedLiveData<T extends { dataProvenance: DataProvenance }>(records: T[]): T[] {
  return records.filter((record) => isVerifiedLiveData(record.dataProvenance));
}

// A record is eligible for a future Hermes training pass when it reflects either genuine live
// market behaviour (verified_external_data) or a deliberately-constructed backtest — both are
// real, intentional signal about how the system behaves, unlike sample_data/fallback_sample_data,
// which only exist because no real data was available at the time.
export function isLearningEligible(provenance: DataProvenance): boolean {
  return provenance === "verified_external_data" || provenance === "backtest";
}

export function filterToLearningEligibleData<T extends { dataProvenance: DataProvenance }>(records: T[]): T[] {
  return records.filter((record) => isLearningEligible(record.dataProvenance));
}
