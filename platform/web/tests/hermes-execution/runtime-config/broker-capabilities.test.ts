import { describe, expect, it } from "vitest";
import { BROKER_CAPABILITIES, brokersWithLiveRateSupport } from "@/lib/hermes-execution/runtime-config/broker-capabilities";
import { SUPPORTED_BROKER_PROVIDERS } from "@/lib/hermes-execution/config";

describe("BROKER_CAPABILITIES", () => {
  it("declares an entry for every supported broker provider", () => {
    expect(Object.keys(BROKER_CAPABILITIES).sort()).toEqual([...SUPPORTED_BROKER_PROVIDERS].sort());
  });

  it("local supports only paper mode, needs no symbol resolution, and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES.local).toMatchObject({
      supportedRuntimeModes: ["paper"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
      requiredCredentialEnvVars: [],
    });
  });

  it("hyperliquid-testnet supports only testnet mode and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES["hyperliquid-testnet"]).toMatchObject({
      supportedRuntimeModes: ["testnet"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
    });
    expect(BROKER_CAPABILITIES["hyperliquid-testnet"].requiredCredentialEnvVars).toContain("HYPERLIQUID_TESTNET_PRIVATE_KEY");
  });

  it("trading212-demo supports only demo mode and cannot supply live rates", () => {
    expect(BROKER_CAPABILITIES["trading212-demo"]).toMatchObject({
      supportedRuntimeModes: ["demo"],
      requiresSymbolResolution: false,
      canSupplyLiveRates: false,
    });
  });

  it("etoro-demo supports only demo mode, requires symbol resolution, and can supply live rates", () => {
    expect(BROKER_CAPABILITIES["etoro-demo"]).toMatchObject({
      supportedRuntimeModes: ["demo"],
      requiresSymbolResolution: true,
      canSupplyLiveRates: true,
    });
    expect(BROKER_CAPABILITIES["etoro-demo"].requiredCredentialEnvVars).toEqual(
      expect.arrayContaining(["ETORO_API_KEY", "ETORO_USER_KEY"]),
    );
  });
});

describe("brokersWithLiveRateSupport", () => {
  it("returns exactly the brokers whose capabilities declare canSupplyLiveRates", () => {
    expect(brokersWithLiveRateSupport()).toEqual(["etoro-demo"]);
  });
});
