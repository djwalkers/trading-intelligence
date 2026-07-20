import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HermesExecutionStatus } from "@/lib/hermes-execution/status";

const { getHermesExecutionStatus } = vi.hoisted(() => ({ getHermesExecutionStatus: vi.fn() }));
vi.mock("@/lib/hermes-execution/status", () => ({ getHermesExecutionStatus }));

// Server components are just async functions returning JSX — calling them directly and awaiting
// the result is the standard way to unit-test one with React Testing Library (no App Router
// runtime required).
async function renderPanel() {
  const { HermesRegistryStatusPanel } = await import("@/components/system-health/HermesRegistryStatusPanel");
  render(await HermesRegistryStatusPanel());
}

function makeStatus(overrides: Partial<HermesExecutionStatus> = {}): HermesExecutionStatus {
  return {
    executionMode: "paper",
    demoExecutionModeEnabled: false,
    registryConfigured: true,
    registryPath: "/path/to/strategy-registry",
    registryConnected: true,
    hermesApprovedCount: 0,
    demoStrategyActive: false,
    openPositions: [],
    completedTrades: [],
    realisedPnl: 0,
    latestEvent: null,
    ...overrides,
  };
}

describe("HermesRegistryStatusPanel", () => {
  it("shows the empty-registry, demo-disabled state accurately", async () => {
    getHermesExecutionStatus.mockResolvedValue(makeStatus());
    await renderPanel();

    expect(screen.getByText("paper")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(3); // approved strategies, open positions, completed trades
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("No execution run recorded yet.")).toBeInTheDocument();
  });

  it("shows demo mode active, open positions, and realised P/L when a demo replay has run", async () => {
    getHermesExecutionStatus.mockResolvedValue(
      makeStatus({
        demoExecutionModeEnabled: true,
        demoStrategyActive: true,
        openPositions: [
          {
            positionId: "position-1",
            strategyId: "DEMO-0001",
            strategyVersion: 1,
            sourceType: "DEMO_ONLY",
            instrument: "DEMO-USD",
            side: "BUY",
            quantity: 4,
            entryPrice: 103,
            entryTimestamp: "2026-01-01T00:05:00Z",
            entryOrderId: "order-1",
          },
        ],
        completedTrades: [
          {
            tradeId: "trade-1",
            positionId: "position-0",
            strategyId: "DEMO-0001",
            strategyVersion: 1,
            sourceType: "DEMO_ONLY",
            instrument: "DEMO-USD",
            side: "BUY",
            quantity: 4,
            entryPrice: 100,
            entryTimestamp: "2026-01-01T00:00:00Z",
            entryOrderId: "order-0",
            exitPrice: 102,
            exitTimestamp: "2026-01-01T00:03:00Z",
            exitOrderId: "order-0b",
            realisedPnl: 8,
            closeReason: "take-profit",
          },
        ],
        realisedPnl: 8,
        latestEvent: {
          timestamp: "2026-01-01T00:08:00Z",
          eventType: "POSITION_CLOSED",
          executionRunId: "run-1",
          details: {},
        },
      }),
    );
    await renderPanel();

    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText(/Realised P\/L: 8\.00/)).toBeInTheDocument();
    expect(screen.getByText(/POSITION_CLOSED/)).toBeInTheDocument();
  });

  it("shows a clear 'not configured' state instead of crashing when the registry path is unset", async () => {
    getHermesExecutionStatus.mockResolvedValue(
      makeStatus({ registryConfigured: false, registryPath: undefined, registryConnected: false }),
    );
    await renderPanel();

    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/HERMES_STRATEGY_REGISTRY_PATH is not configured/)).toBeInTheDocument();
  });
});
