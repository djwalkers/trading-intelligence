import { describe, expect, it } from "vitest";
import { resolveMarketScreeningShortlist } from "@/lib/market-screening/resolve-market-screening-shortlist";
import { instruments as staticInstruments } from "@/lib/mock";
import type { Instrument } from "@/lib/types";

describe("resolveMarketScreeningShortlist", () => {
  it("falls back to the static instrument list when the rollout stage is off, without calling the provider", async () => {
    const result = await resolveMarketScreeningShortlist("off");
    expect(result.source).toBe("fallback-static-list");
    expect(result.instruments).toBe(staticInstruments);
    if (result.source === "fallback-static-list") {
      expect(result.reason).toContain("off");
    }
  });

  it("returns the exact instruments array passed in, by reference, when provided", async () => {
    const fixture: Instrument[] = [staticInstruments[0]!];
    const result = await resolveMarketScreeningShortlist("off", fixture);
    expect(result.instruments).toBe(fixture);
  });

  it("still falls back for a rollout stage other than off, since no stage is implemented yet", async () => {
    const result = await resolveMarketScreeningShortlist("shadow");
    expect(result.source).toBe("fallback-static-list");
    expect(result.instruments).toBe(staticInstruments);
    if (result.source === "fallback-static-list") {
      expect(result.reason).toBe("Provider not configured.");
    }
  });
});
