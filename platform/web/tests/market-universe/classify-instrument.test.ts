import { describe, expect, it } from "vitest";
import { classifyInstrumentType, isSupportedInstrumentType } from "@/lib/market-universe/classify-instrument";

describe("classifyInstrumentType", () => {
  it("trusts the real ETF flag over any name pattern, and reports it as source_flag", () => {
    expect(classifyInstrumentType("Invesco QQQ Trust", true, "QQQQ")).toEqual({
      type: "etf",
      method: "source_flag",
    });
  });

  it("identifies an ADR by name as name_pattern_inferred", () => {
    expect(classifyInstrumentType("Toyota Motor Corp Sponsored ADR", false, "TM")).toEqual({
      type: "adr",
      method: "name_pattern_inferred",
    });
    expect(classifyInstrumentType("Example Corp American Depositary Shares", false, "EXMP")).toEqual({
      type: "adr",
      method: "name_pattern_inferred",
    });
  });

  it("identifies a REIT by name as name_pattern_inferred", () => {
    expect(classifyInstrumentType("Realty Income Corp REIT", false, "O")).toEqual({
      type: "reit",
      method: "name_pattern_inferred",
    });
    expect(classifyInstrumentType("Example Real Estate Investment Trust", false, "EXRT")).toEqual({
      type: "reit",
      method: "name_pattern_inferred",
    });
  });

  it("classifies warrants, rights, units, and preferred shares as unsupported (name_pattern_inferred)", () => {
    expect(classifyInstrumentType("Example Corp Warrants", false, "EXMPW").type).toBe("unsupported");
    expect(classifyInstrumentType("Example Corp Rights", false, "EXMPR").type).toBe("unsupported");
    expect(classifyInstrumentType("Example Acquisition Corp Units", false, "EXMPU").type).toBe("unsupported");
    expect(classifyInstrumentType("Example Corp 6% Preferred Stock", false, "EXMPP").type).toBe("unsupported");
  });

  it("classifies an ordinary common stock as equity (name_pattern_inferred)", () => {
    expect(classifyInstrumentType("Apple Inc. - Common Stock", false, "AAPL")).toEqual({
      type: "equity",
      method: "name_pattern_inferred",
    });
  });

  it("catches the NASDAQ 5th-character suffix convention as a secondary check", () => {
    // No name-pattern signal, only the suffix — the documented residual-heuristic case.
    expect(classifyInstrumentType("Example Corp", false, "EXMPW").type).toBe("unsupported");
  });

  it("does not misclassify a genuine 4-letter equity ticker", () => {
    expect(classifyInstrumentType("Example Corp - Common Stock", false, "EXMP").type).toBe("equity");
  });
});

describe("isSupportedInstrumentType", () => {
  it("is true for equity, etf, adr, and reit", () => {
    expect(isSupportedInstrumentType("equity")).toBe(true);
    expect(isSupportedInstrumentType("etf")).toBe(true);
    expect(isSupportedInstrumentType("adr")).toBe(true);
    expect(isSupportedInstrumentType("reit")).toBe(true);
  });

  it("is false only for unsupported", () => {
    expect(isSupportedInstrumentType("unsupported")).toBe(false);
  });
});
