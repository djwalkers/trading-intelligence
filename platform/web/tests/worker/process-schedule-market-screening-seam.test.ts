import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { instruments as staticInstruments } from "@/lib/mock";
import type { ScheduleRow } from "@/lib/scheduler/server-schedule-store";

// Sprint 295 objective 5/8 — proves the worker's traded instrument list is byte-for-byte unchanged
// now that the (inert) market-screening seam sits in front of it. Every Supabase-touching
// collaborator is mocked; only the market-screening resolution path
// (resolveMarketScreeningShortlist, real, unmocked) and executeBotScan's call arguments (captured
// via the mock below) are under test.

const claimScheduleLockMock = vi.fn();
const releaseScheduleLockMock = vi.fn();
vi.mock("@/lib/scheduler/server-schedule-store", () => ({
  claimScheduleLock: (...args: unknown[]) => claimScheduleLockMock(...args),
  releaseScheduleLock: (...args: unknown[]) => releaseScheduleLockMock(...args),
}));

const executeBotScanMock = vi.fn();
vi.mock("@/lib/bot", () => ({
  executeBotScan: (...args: unknown[]) => executeBotScanMock(...args),
}));

vi.mock("@/lib/market-data/get-server-historical-market-data-provider", () => ({
  getServerHistoricalMarketDataProvider: () => ({
    getHistoricalCandles: vi.fn(),
    getHistoricalCandlesWithTelemetry: vi.fn(),
    getStatus: () => ({
      provider: "Sample data",
      source: "Mock",
      mode: "Mocked",
      lastUpdated: null,
      instrumentsLoaded: 0,
      fallbackActive: false,
      failureReason: null,
      cacheAgeMinutes: null,
    }),
  }),
}));

const schedule: ScheduleRow = {
  id: "schedule-1",
  user_id: "user-1",
  enabled: true,
  interval_minutes: 15,
  next_scan_at: null,
  last_scan_at: null,
  last_status: null,
  last_error: null,
  locked_at: null,
  locked_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("processSchedule — market-screening integration seam (Sprint 295)", () => {
  it("passes the exact static instrument list to executeBotScan, unchanged, with the rollout stage defaulted to off", async () => {
    claimScheduleLockMock.mockResolvedValue({ ...schedule, locked_by: "worker-test" });
    releaseScheduleLockMock.mockResolvedValue(undefined);
    executeBotScanMock.mockResolvedValue({
      decision: { actionTaken: "No Trade", candidates: [] },
      trade: null,
    });

    const { processSchedule } = await import("@/worker/process-schedule");
    const fakeClient = {} as SupabaseClient;

    await processSchedule(fakeClient, schedule, "worker-test");

    expect(executeBotScanMock).toHaveBeenCalledTimes(1);
    const callArgs = executeBotScanMock.mock.calls[0]?.[0];
    expect(callArgs.instruments).toBe(staticInstruments);
    expect(callArgs.triggerType).toBe("Scheduled");
  });
});
