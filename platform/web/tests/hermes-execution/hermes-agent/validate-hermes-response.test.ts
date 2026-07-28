import { describe, expect, it } from "vitest";
import { extractJsonFromOutput, validateHermesUniverseResponse } from "@/lib/hermes-execution/hermes-agent/validate-hermes-response";

// Prototype 1.0 — official Hermes Agent decision integration. Pure validation tests — no
// subprocess, no network call, no real Hermes CLI anywhere in this file.

const UNIVERSE = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];

function validProposal(overrides: Record<string, unknown> = {}) {
  return {
    instrument: "ETH",
    action: "BUY",
    confidence: 0.82,
    reasoning: ["Bullish momentum across recent candles", "Volatility remains within permitted range"],
    suggestedStopLossPercent: 2,
    suggestedTakeProfitPercent: 4,
    ...overrides,
  };
}

describe("extractJsonFromOutput", () => {
  it("parses a response that is only JSON", () => {
    expect(extractJsonFromOutput('{"proposals":[]}')).toEqual({ proposals: [] });
  });

  it("extracts JSON surrounded by prose", () => {
    const text = 'Sure, here is my analysis:\n{"proposals":[]}\nLet me know if you need anything else!';
    expect(extractJsonFromOutput(text)).toEqual({ proposals: [] });
  });

  it("returns undefined for text with no valid JSON anywhere", () => {
    expect(extractJsonFromOutput("I cannot provide a structured response right now.")).toBeUndefined();
  });

  it("returns undefined for empty/whitespace-only text", () => {
    expect(extractJsonFromOutput("   \n  ")).toBeUndefined();
  });
});

describe("validateHermesUniverseResponse — valid ranked response", () => {
  it("accepts a well-formed response with multiple proposals", () => {
    const raw = JSON.stringify({ proposals: [validProposal(), validProposal({ instrument: "BTC", action: "SELL", confidence: 0.6 })] });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]).toEqual({
      instrument: "ETH",
      action: "BUY",
      confidence: 0.82,
      reasoning: ["Bullish momentum across recent candles", "Volatility remains within permitted range"],
      suggestedStopLossPercent: 2,
      suggestedTakeProfitPercent: 4,
    });
  });

  it("accepts an empty proposals array (Hermes found nothing eligible this scan)", () => {
    const result = validateHermesUniverseResponse('{"proposals":[]}', UNIVERSE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposals).toEqual([]);
  });

  it("tolerates prose wrapped around the JSON", () => {
    const text = `Here is my analysis for this scan:\n${JSON.stringify({ proposals: [validProposal()] })}\nHope that helps.`;
    const result = validateHermesUniverseResponse(text, UNIVERSE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposals).toHaveLength(1);
  });
});

describe("validateHermesUniverseResponse — malformed JSON", () => {
  it("fails closed for text with no JSON at all", () => {
    const result = validateHermesUniverseResponse("I refuse to answer in JSON.", UNIVERSE);
    expect(result.ok).toBe(false);
  });

  it("fails closed for truncated/invalid JSON", () => {
    const result = validateHermesUniverseResponse('{"proposals":[{"instrument":"ETH"', UNIVERSE);
    expect(result.ok).toBe(false);
  });

  it("fails closed when the extracted JSON is not an object", () => {
    const result = validateHermesUniverseResponse("[1,2,3]", UNIVERSE);
    expect(result.ok).toBe(false);
  });
});

describe("validateHermesUniverseResponse — missing proposals field", () => {
  it("fails closed when \"proposals\" is absent", () => {
    const result = validateHermesUniverseResponse('{"somethingElse":[]}', UNIVERSE);
    expect(result.ok).toBe(false);
  });

  it("fails closed when \"proposals\" is not an array", () => {
    const result = validateHermesUniverseResponse('{"proposals":"none"}', UNIVERSE);
    expect(result.ok).toBe(false);
  });
});

describe("validateHermesUniverseResponse — duplicate instrument", () => {
  it("fails the whole response closed when the same instrument appears twice", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ instrument: "ETH" }), validProposal({ instrument: "ETH", action: "SELL" })] });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/duplicate/i);
  });
});

describe("validateHermesUniverseResponse — unknown instrument", () => {
  it("rejects an instrument not in the configured universe", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ instrument: "DOGE" })] });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/universe/i);
  });
});

describe("validateHermesUniverseResponse — unsupported action", () => {
  it("rejects an action outside BUY/SELL/HOLD", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ action: "SHORT" })] });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string action", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ action: 1 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });
});

describe("validateHermesUniverseResponse — invalid confidence", () => {
  it("rejects confidence above 1", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ confidence: 1.5 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ confidence: -0.1 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects non-finite confidence (NaN/Infinity smuggled through a string)", () => {
    const raw = '{"proposals":[{"instrument":"ETH","action":"BUY","confidence":"NaN","reasoning":[]}]}';
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });
});

describe("validateHermesUniverseResponse — unsafe stop-loss/take-profit", () => {
  it("rejects an excessive stop-loss percent", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ suggestedStopLossPercent: 50 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects a zero or negative stop-loss percent", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ suggestedStopLossPercent: 0 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects an excessive take-profit percent", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ suggestedTakeProfitPercent: 999 })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("accepts proposals with no suggested stop-loss/take-profit at all (both optional)", () => {
    const raw = JSON.stringify({
      proposals: [{ instrument: "ETH", action: "BUY", confidence: 0.7, reasoning: ["ok"] }],
    });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposals[0]?.suggestedStopLossPercent).toBeUndefined();
      expect(result.proposals[0]?.suggestedTakeProfitPercent).toBeUndefined();
    }
  });
});

describe("validateHermesUniverseResponse — hallucinated quantity/notional/leverage/broker/credentials are discarded, never rejected-for", () => {
  it("silently drops quantity/notional/leverage/broker/credential fields rather than propagating or rejecting on them", () => {
    const raw = JSON.stringify({
      proposals: [
        validProposal({
          quantity: 1000,
          notional: 50000,
          leverage: 20,
          broker: "etoro-live",
          apiKey: "sk-should-never-appear",
          orderInstructions: "market buy now",
        }),
      ],
    });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const proposal = result.proposals[0] as unknown as Record<string, unknown>;
    expect(proposal.quantity).toBeUndefined();
    expect(proposal.notional).toBeUndefined();
    expect(proposal.leverage).toBeUndefined();
    expect(proposal.broker).toBeUndefined();
    expect(proposal.apiKey).toBeUndefined();
    expect(proposal.orderInstructions).toBeUndefined();
    expect(Object.keys(proposal).sort()).toEqual(
      ["action", "confidence", "instrument", "reasoning", "suggestedStopLossPercent", "suggestedTakeProfitPercent"].sort(),
    );
  });

  it("silently drops any tool-call-shaped field — the output contract has no mechanism for Hermes to request tool execution", () => {
    const raw = JSON.stringify({
      proposals: [
        validProposal({
          tool: "execute_trade",
          toolCalls: [{ name: "shell", arguments: { command: "rm -rf /" } }],
          function_call: { name: "place_order" },
          execute: true,
        }),
      ],
    });
    const result = validateHermesUniverseResponse(raw, UNIVERSE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const proposal = result.proposals[0] as unknown as Record<string, unknown>;
    expect(proposal.tool).toBeUndefined();
    expect(proposal.toolCalls).toBeUndefined();
    expect(proposal.function_call).toBeUndefined();
    expect(proposal.execute).toBeUndefined();
  });
});

describe("validateHermesUniverseResponse — reasoning bounds", () => {
  it("rejects a reasoning array exceeding the maximum item count", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ reasoning: Array.from({ length: 20 }, (_, i) => `reason ${i}`) })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects an overly long individual reasoning string", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ reasoning: ["a".repeat(1000)] })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });

  it("rejects a non-string item inside reasoning", () => {
    const raw = JSON.stringify({ proposals: [validProposal({ reasoning: [42] })] });
    expect(validateHermesUniverseResponse(raw, UNIVERSE).ok).toBe(false);
  });
});
