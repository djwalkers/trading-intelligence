import { describe, expect, it } from "vitest";
import { parseRunJson } from "@/lib/research-import/parse-run-json";
import { ResearchRunImportError } from "@/lib/research-import/types";

function validRunJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "test-run-001",
    symbol: "AAPL",
    strategyName: "momentum-breakout",
    model: "gpt-5",
    status: "complete",
    verdict: "reject",
    verdictReason: "No statistically significant edge over baseline.",
    dataSource: "alpha-vantage",
    dateRangeStart: "2024-01-01",
    dateRangeEnd: "2024-12-31",
    hypothesis: "Momentum breakouts outperform buy-and-hold.",
    falsificationCriterion: "Sharpe ratio does not improve by 0.2 or more.",
    createdAt: "2026-07-01T00:00:00Z",
    checksums: {
      "hypothesis.md": "abc123",
    },
    ...overrides,
  });
}

describe("parseRunJson", () => {
  it("parses a well-formed run.json into the known fields", () => {
    const parsed = parseRunJson(validRunJson());
    expect(parsed.runId).toBe("test-run-001");
    expect(parsed.symbol).toBe("AAPL");
    expect(parsed.strategyName).toBe("momentum-breakout");
    expect(parsed.verdict).toBe("reject");
    expect(parsed.checksums["hypothesis.md"]).toBe("abc123");
  });

  it("preserves the full raw object, including fields it doesn't otherwise read", () => {
    const parsed = parseRunJson(validRunJson({ futureField: "some-future-value" }));
    expect(parsed.raw.futureField).toBe("some-future-value");
  });

  it("ignores unknown fields rather than failing", () => {
    expect(() =>
      parseRunJson(validRunJson({ unexpectedNestedThing: { a: 1, b: [1, 2, 3] } })),
    ).not.toThrow();
  });

  it("treats optional date-range fields as null when absent", () => {
    const raw = JSON.parse(validRunJson());
    delete raw.dateRangeStart;
    delete raw.dateRangeEnd;
    const parsed = parseRunJson(JSON.stringify(raw));
    expect(parsed.dateRangeStart).toBeNull();
    expect(parsed.dateRangeEnd).toBeNull();
  });

  it("defaults checksums to an empty object when the field is missing", () => {
    const raw = JSON.parse(validRunJson());
    delete raw.checksums;
    const parsed = parseRunJson(JSON.stringify(raw));
    expect(parsed.checksums).toEqual({});
  });

  it("rejects malformed JSON with reason malformed_json", () => {
    try {
      parseRunJson("{ not valid json");
      throw new Error("expected parseRunJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("malformed_json");
    }
  });

  it("rejects a JSON value that isn't an object with reason malformed_json", () => {
    try {
      parseRunJson('"just a string"');
      throw new Error("expected parseRunJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("malformed_json");
    }
  });

  it("rejects with missing_required_field naming the absent field", () => {
    const raw = JSON.parse(validRunJson());
    delete raw.verdict;
    try {
      parseRunJson(JSON.stringify(raw));
      throw new Error("expected parseRunJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("missing_required_field");
      expect((error as ResearchRunImportError).message).toContain("verdict");
    }
  });

  it("rejects an empty-string required field the same as a missing one", () => {
    try {
      parseRunJson(validRunJson({ hypothesis: "" }));
      throw new Error("expected parseRunJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("missing_required_field");
    }
  });
});
