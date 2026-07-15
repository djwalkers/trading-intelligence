import { describe, expect, it } from "vitest";
import { computeResultsDiff } from "@/lib/research-import/compute-results-diff";

describe("computeResultsDiff", () => {
  it("computes a key-by-key numeric diff of v2 minus v1", () => {
    const diff = computeResultsDiff({ sharpe: 1.0, maxDrawdown: -0.1 }, { sharpe: 1.4, maxDrawdown: -0.05 });
    expect(diff.sharpe).toBeCloseTo(0.4);
    expect(diff.maxDrawdown).toBeCloseTo(0.05);
  });

  it("omits a key that is missing from one side rather than coercing it to zero", () => {
    const diff = computeResultsDiff({ sharpe: 1.0, winRate: 0.5 }, { sharpe: 1.4 });
    expect(diff.sharpe).toBeCloseTo(0.4);
    expect(diff.winRate).toBeUndefined();
    expect(Object.keys(diff)).not.toContain("winRate");
  });

  it("skips a key whose value isn't numeric on either side", () => {
    const diff = computeResultsDiff({ sharpe: 1.0, notes: "n/a" }, { sharpe: 1.2, notes: "still n/a" });
    expect(diff.sharpe).toBeCloseTo(0.2);
    expect(diff.notes).toBeUndefined();
  });

  it("returns an empty object for two empty inputs", () => {
    expect(computeResultsDiff({}, {})).toEqual({});
  });

  it("never fabricates a value for a key absent from both required sides", () => {
    const diff = computeResultsDiff({ a: 1 }, { b: 2 });
    expect(diff).toEqual({});
  });
});
