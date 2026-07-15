// Pure. Key-by-key numeric diff of two results objects — every key present in either object is
// considered; a key missing from one side is treated as genuinely absent (never coerced to zero),
// so a metric that only exists in one version never silently reads as "no change." Non-numeric
// values are skipped entirely, since a numeric diff is only meaningful for numeric metrics — this
// never fabricates a value for a key it can't actually compute one for.
export function computeResultsDiff(
  resultsV1: Record<string, unknown>,
  resultsV2: Record<string, unknown>,
): Record<string, number> {
  const diff: Record<string, number> = {};
  const keys = new Set([...Object.keys(resultsV1), ...Object.keys(resultsV2)]);

  for (const key of keys) {
    const v1 = resultsV1[key];
    const v2 = resultsV2[key];
    if (typeof v1 === "number" && typeof v2 === "number") {
      diff[key] = v2 - v1;
    }
  }

  return diff;
}
