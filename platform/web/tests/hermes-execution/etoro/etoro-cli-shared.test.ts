import { describe, expect, it, vi } from "vitest";
import type { HermesExecutionConfig } from "@/lib/hermes-execution/config";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

import { checkEtoroDemoConfig, connectEtoroDemoBroker } from "@/hermes-execution/etoro-cli-shared";

function makeConfig(overrides: Partial<HermesExecutionConfig["etoro"]> = {}): HermesExecutionConfig {
  return {
    etoro: {
      env: "demo",
      apiKey: "test-key",
      userKey: "test-user-key",
      testInstrument: "BTC",
      testAmount: 50,
      httpTimeoutMs: 10_000,
      ...overrides,
    },
  } as HermesExecutionConfig;
}

describe("checkEtoroDemoConfig", () => {
  it("passes when env is demo and both credentials are set", () => {
    expect(checkEtoroDemoConfig(makeConfig())).toEqual({ ok: true });
  });

  it("fails when env is not demo", () => {
    const result = checkEtoroDemoConfig(makeConfig({ env: undefined }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ETORO_ENV/);
  });

  it("fails when the API key is missing", () => {
    const result = checkEtoroDemoConfig(makeConfig({ apiKey: undefined }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ETORO_API_KEY/);
  });

  it("fails when the user key is missing", () => {
    const result = checkEtoroDemoConfig(makeConfig({ userKey: undefined }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ETORO_API_KEY/);
  });
});

describe("connectEtoroDemoBroker", () => {
  it("always requests the etoro-demo provider from BrokerFactory", async () => {
    createMock.mockReset();
    const fakeBroker = { fake: true };
    createMock.mockResolvedValue(fakeBroker);

    const config = makeConfig();
    const result = await connectEtoroDemoBroker(config, { record: vi.fn() } as never, "run-1");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[3]).toEqual({ provider: "etoro-demo" });
    expect(result).toBe(fakeBroker);
  });
});
