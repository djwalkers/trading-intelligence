import { describe, expect, it } from "vitest";
import { buildInstrumentCatalogue, type InstrumentCatalogueEntry } from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";
import { findProhibitedFields, validateStrategyDefinition, compareSemver, parseSemver } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";

// Phase 1 declarative strategy schema — pure/fixture-only tests. Never calls eToro, never touches
// the filesystem, never runs a broker/probe/smoke command.

function catalogueEntries(overrides: Record<string, Partial<InstrumentCatalogueEntry>> = {}): InstrumentCatalogueEntry[] {
  const base = buildInstrumentCatalogue({
    seedSymbols: ["BTC", "ETH", "SOL"],
    configuredUniverse: ["BTC", "ETH", "SOL"],
    evidence: { sourceDirectory: "", accepted: [], rejected: [] },
  });
  return base.map((entry) => ({ ...entry, ...overrides[entry.symbol] }));
}

const VERIFIED_CATALOGUE = catalogueEntries({
  BTC: { readOnlyCapabilityStatus: "READ_ONLY_VERIFIED" },
  ETH: { readOnlyCapabilityStatus: "READ_ONLY_VERIFIED" },
  SOL: { readOnlyCapabilityStatus: "READ_ONLY_VERIFIED" },
});

function validDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    strategyId: "TEST_STRATEGY_V1",
    strategyVersion: "1.0.0",
    name: "Test Strategy",
    description: "A test fixture strategy.",
    status: "APPROVED_FOR_BACKTEST",
    strategyFamily: "TREND_FOLLOWING",
    assetClass: "crypto",
    supportedInstruments: ["BTC"],
    timeframe: "1h",
    dataRequirements: ["close"],
    indicators: [
      { id: "ema20", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "EMA20" },
      { id: "ema50", type: "EMA", sourceField: "close", parameters: { period: 50 }, outputAlias: "EMA50" },
    ],
    entryRules: {
      operator: "GREATER_THAN",
      left: { kind: "INDICATOR_ALIAS", alias: "EMA20" },
      right: { kind: "INDICATOR_ALIAS", alias: "EMA50" },
    },
    signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 100 }],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: true, requiresStage4Verified: false, requiresConfiguredUniverse: true, notes: [] },
    backtestPolicy: { minHistoryBars: 100, warmupBars: 50, notes: [] },
    provenance: { author: "test", createdAt: "2026-07-31T00:00:00.000Z", notes: [] },
    limitations: [],
    ...overrides,
  };
}

describe("findProhibitedFields", () => {
  it("finds a top-level prohibited field", () => {
    expect(findProhibitedFields({ leverage: 5 })).toEqual(["leverage"]);
  });

  it("finds a prohibited field nested arbitrarily deep", () => {
    expect(findProhibitedFields({ parameters: { nested: { stopLossPercent: 0.02 } } })).toEqual(["parameters.nested.stopLossPercent"]);
  });

  it("matches regardless of case/separator style", () => {
    expect(findProhibitedFields({ Stop_Loss: 1 })).toEqual(["Stop_Loss"]);
  });

  it("finds prohibited fields inside array elements", () => {
    expect(findProhibitedFields({ list: [{ killSwitch: true }] })).toEqual(["list[0].killSwitch"]);
  });

  it("finds nothing in a clean document", () => {
    expect(findProhibitedFields(validDoc())).toEqual([]);
  });
});

describe("compareSemver / parseSemver", () => {
  it("parses strict MAJOR.MINOR.PATCH", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
  });

  it("rejects non-semver strings", () => {
    expect(parseSemver("1.2")).toBeUndefined();
    expect(parseSemver("1.2.3-beta")).toBeUndefined();
    expect(parseSemver("v1.2.3")).toBeUndefined();
  });

  it("orders numerically, not lexicographically (10.0.0 > 9.0.0)", () => {
    expect(compareSemver("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });

  it("compares minor/patch correctly", () => {
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.5", "1.2.4")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("validateStrategyDefinition", () => {
  it("accepts a well-formed document", () => {
    const result = validateStrategyDefinition(validDoc(), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.result.valid).toBe(true);
      expect(result.record.result.usableForBacktest).toBe(true);
      expect(result.record.result.usableForDemo).toBe(false);
    }
  });

  it("rejects an old schema version", () => {
    const result = validateStrategyDefinition(validDoc({ schemaVersion: 0 }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result).toMatchObject({ ok: false, reason: "SCHEMA_VERSION_TOO_OLD" });
  });

  it("rejects an invalid strategyId", () => {
    const result = validateStrategyDefinition(validDoc({ strategyId: "not-valid-id" }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result).toMatchObject({ ok: false, reason: "INVALID_STRATEGY_ID" });
  });

  it("rejects a non-semver strategyVersion", () => {
    const result = validateStrategyDefinition(validDoc({ strategyVersion: "v1" }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result).toMatchObject({ ok: false, reason: "INVALID_STRATEGY_VERSION" });
  });

  it("rejects an unrecognised status", () => {
    const result = validateStrategyDefinition(validDoc({ status: "LIVE" }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported timeframe", () => {
    const result = validateStrategyDefinition(validDoc({ timeframe: "5m" }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result.ok).toBe(false);
  });

  it("rejects an unrecognised top-level field rather than silently ignoring it", () => {
    const result = validateStrategyDefinition(validDoc({ notAKnownField: true }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result).toMatchObject({ ok: false, reason: "UNEXPECTED_SHAPE" });
  });

  it("rejects a leading-zero semver component (e.g. 01.0.0)", () => {
    const result = validateStrategyDefinition(validDoc({ strategyVersion: "01.0.0" }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result).toMatchObject({ ok: false, reason: "INVALID_STRATEGY_VERSION" });
  });

  it("rejects duplicate entries in supportedInstruments", () => {
    const result = validateStrategyDefinition(validDoc({ supportedInstruments: ["BTC", "BTC"] }), "/tmp/x.json", VERIFIED_CATALOGUE);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate indicator ids even when outputAliases differ", () => {
    const doc = validDoc({
      indicators: [
        { id: "same-id", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "EMA20" },
        { id: "same-id", type: "EMA", sourceField: "close", parameters: { period: 50 }, outputAlias: "EMA50" },
      ],
    });
    expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_INDICATOR" });
  });

  it("rejects an outputAlias that collides with a reserved market-field name", () => {
    const doc = validDoc({ indicators: [{ id: "e1", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "close" }] });
    expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_INDICATOR" });
  });

  it("recursion depth guard: an absurdly deep rule tree is rejected rather than crashing", () => {
    let rule: unknown = { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: 1 } };
    for (let i = 0; i < 200; i++) {
      rule = { operator: "AND", rules: [rule, { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: i } }] };
    }
    expect(() => validateStrategyDefinition(validDoc({ entryRules: rule }), "/tmp/x.json", VERIFIED_CATALOGUE)).not.toThrow();
    expect(validateStrategyDefinition(validDoc({ entryRules: rule }), "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
  });

  describe("prohibited fields", () => {
    for (const field of [
      "leverage",
      "stopLossPercent",
      "takeProfit",
      "killSwitch",
      "brokerProvider",
      "accountMode",
      "approvalMode",
      "executionRouting",
      "maxOpenPositions",
      "liveMode",
      // Naming-variant synonyms added after the Phase 1 pre-commit review found these bypassed
      // exact-match detection.
      "orderQuantity",
      "maximumPositions",
      "brokerId",
      "portfolioRiskLimit",
      "tradingMode",
      "routingMode",
      "accountType",
    ]) {
      it(`rejects a document containing "${field}" anywhere in the tree`, () => {
        const result = validateStrategyDefinition(validDoc({ parameters: { [field]: 1 } }), "/tmp/x.json", VERIFIED_CATALOGUE);
        expect(result).toMatchObject({ ok: false, reason: "PROHIBITED_FIELD" });
      });
    }

    it("reports every prohibited field found, not just the first", () => {
      const result = validateStrategyDefinition(validDoc({ leverage: 2, parameters: { stopLoss: 1 } }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toContain("leverage");
        expect(result.detail).toContain("parameters.stopLoss");
      }
    });
  });

  describe("instruments", () => {
    it("rejects an unknown instrument outright", () => {
      const result = validateStrategyDefinition(validDoc({ supportedInstruments: ["DOGE"] }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_INSTRUMENT" });
    });

    it("accepts (with a warning, not an error) an instrument that exists in the catalogue but isn't read-only-verified", () => {
      const unverified = catalogueEntries();
      const result = validateStrategyDefinition(validDoc({ supportedInstruments: ["BTC"] }), "/tmp/x.json", unverified);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.result.validationWarnings.length).toBeGreaterThan(0);
        expect(result.record.result.unavailableInstruments).toContain("BTC");
        expect(result.record.result.supportedCatalogueInstruments).toContain("BTC");
      }
    });

    it("supports multiple instruments (BTC, ETH, SOL) in one strategy", () => {
      const result = validateStrategyDefinition(validDoc({ supportedInstruments: ["BTC", "ETH", "SOL"] }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.result.supportedCatalogueInstruments).toEqual(["BTC", "ETH", "SOL"]);
    });
  });

  describe("indicators", () => {
    it("rejects a non-positive-integer period", () => {
      const doc = validDoc({ indicators: [{ id: "e1", type: "EMA", sourceField: "close", parameters: { period: 0 }, outputAlias: "E1" }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_INDICATOR" });
    });

    it("rejects a fractional period", () => {
      const doc = validDoc({ indicators: [{ id: "e1", type: "EMA", sourceField: "close", parameters: { period: 20.5 }, outputAlias: "E1" }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects duplicate output aliases", () => {
      const doc = validDoc({
        indicators: [
          { id: "e1", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "DUP" },
          { id: "e2", type: "EMA", sourceField: "close", parameters: { period: 50 }, outputAlias: "DUP" },
        ],
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_INDICATOR" });
    });

    it("rejects an unsupported source field", () => {
      const doc = validDoc({ indicators: [{ id: "e1", type: "EMA", sourceField: "bid", parameters: { period: 20 }, outputAlias: "E1" }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects an unrecognised indicator type", () => {
      const doc = validDoc({ indicators: [{ id: "e1", type: "MACD", sourceField: "close", parameters: { period: 20 }, outputAlias: "E1" }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects an indicator with an extra field (e.g. a formula string)", () => {
      const doc = validDoc({
        indicators: [{ id: "e1", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "E1", formula: "close * 2" }],
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_INDICATOR" });
    });

    it("accepts EMA, RSI, and ATR", () => {
      const doc = validDoc({
        indicators: [
          { id: "e1", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "EMA20" },
          { id: "r1", type: "RSI", sourceField: "close", parameters: { period: 14 }, outputAlias: "RSI14" },
          { id: "a1", type: "ATR", sourceField: "close", parameters: { period: 14 }, outputAlias: "ATR14" },
        ],
        entryRules: { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "MARKET_FIELD", field: "close" } },
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(true);
    });
  });

  describe("entry rule tree", () => {
    it("rejects a reference to an undeclared indicator alias", () => {
      const doc = validDoc({ entryRules: { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "GHOST" }, right: { kind: "CONSTANT", value: 1 } } });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_RULE_TREE" });
    });

    it("rejects a reference to an undeclared/unsafe market field", () => {
      const doc = validDoc({ entryRules: { operator: "GREATER_THAN", left: { kind: "MARKET_FIELD", field: "bid" }, right: { kind: "CONSTANT", value: 1 } } });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects a comparison between two constants (never references market data)", () => {
      const doc = validDoc({ entryRules: { operator: "GREATER_THAN", left: { kind: "CONSTANT", value: 5 }, right: { kind: "CONSTANT", value: 3 } } });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE)).toMatchObject({ ok: false, reason: "INVALID_RULE_TREE" });
    });

    it("rejects AND/OR with fewer than two children", () => {
      const doc = validDoc({ entryRules: { operator: "AND", rules: [{ operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: 1 } }] } });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects a BETWEEN whose own tested operand is a constant", () => {
      const doc = validDoc({
        entryRules: { operator: "BETWEEN", operand: { kind: "CONSTANT", value: 5 }, lowerBound: { kind: "CONSTANT", value: 1 }, upperBound: { kind: "CONSTANT", value: 10 } },
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects an impossible BETWEEN range (lowerBound >= upperBound)", () => {
      const doc = validDoc({
        entryRules: { operator: "BETWEEN", operand: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, lowerBound: { kind: "CONSTANT", value: 70 }, upperBound: { kind: "CONSTANT", value: 30 } },
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("accepts a valid nested AND/OR tree", () => {
      const doc = validDoc({
        entryRules: {
          operator: "AND",
          rules: [
            { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA50" } },
            {
              operator: "OR",
              rules: [
                { operator: "CROSSES_ABOVE", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: 100 } },
                { operator: "LESS_THAN_OR_EQUAL", left: { kind: "MARKET_FIELD", field: "close" }, right: { kind: "CONSTANT", value: 1000 } },
              ],
            },
          ],
        },
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(true);
    });

    it("rejects arbitrary JavaScript/SQL/shell-shaped payloads passed as a rule", () => {
      const doc = validDoc({ entryRules: { operator: "GREATER_THAN", left: { kind: "CONSTANT", value: 1, code: "require('child_process').exec('ls')" }, right: { kind: "CONSTANT", value: 0 } } });
      // A constant-vs-constant comparison is rejected regardless of any extra injected field —
      // never evaluated, never trusted as anything but a malformed rule.
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects a rule tree exceeding the maximum node count", () => {
      let rule: unknown = { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: 1 } };
      for (let i = 0; i < 70; i++) {
        rule = { operator: "OR", rules: [rule, { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "CONSTANT", value: i } }] };
      }
      const doc = validDoc({ entryRules: rule });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });
  });

  describe("signal exit rules", () => {
    it("accepts a CONDITION exit referencing a valid rule", () => {
      const doc = validDoc({
        signalExitRules: [{ kind: "CONDITION", rule: { operator: "CROSSES_BELOW", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA50" } } }],
      });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(true);
    });

    it("rejects a MAX_BARS_HELD with a non-positive value", () => {
      const doc = validDoc({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 0 }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });

    it("rejects an unrecognised exit kind", () => {
      const doc = validDoc({ signalExitRules: [{ kind: "TRAILING_STOP", distance: 1 }] });
      expect(validateStrategyDefinition(doc, "/tmp/x.json", VERIFIED_CATALOGUE).ok).toBe(false);
    });
  });

  describe("usableForDemo / usableForBacktest", () => {
    it("usableForDemo is false even when status is APPROVED_FOR_DEMO (no promotion mechanism exists yet)", () => {
      const result = validateStrategyDefinition(validDoc({ status: "APPROVED_FOR_DEMO" }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.result.usableForDemo).toBe(false);
    });

    it("usableForBacktest is false for a DRAFT strategy even if otherwise valid", () => {
      const result = validateStrategyDefinition(validDoc({ status: "DRAFT" }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.result.usableForBacktest).toBe(false);
    });

    it("usableForBacktest is false for a RETIRED strategy", () => {
      const result = validateStrategyDefinition(validDoc({ status: "RETIRED" }), "/tmp/x.json", VERIFIED_CATALOGUE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.result.usableForBacktest).toBe(false);
    });
  });
});
