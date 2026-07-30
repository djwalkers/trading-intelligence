import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Legacy-worker UI cleanup — required tests: "legacy worker status is not shown as Hermes
// status" and "Hermes runtime and broker status remain unchanged." Child panels are stubbed
// since each has its own dedicated test coverage — this test is about page-level separation and
// the removal of the page's own previously-false claim.

vi.mock("@/components/system-health/PlatformHealthOverview", () => ({
  PlatformHealthOverview: () => <div data-testid="platform-health-overview" />,
}));
vi.mock("@/components/system-health/HermesAgentStatusPanel", () => ({
  HermesAgentStatusPanel: () => <div data-testid="hermes-agent-status-panel" />,
}));
vi.mock("@/components/system-health/DatabaseStatusPanel", () => ({ DatabaseStatusPanel: () => <div /> }));
vi.mock("@/components/system-health/AuthStatusPanel", () => ({ AuthStatusPanel: () => <div /> }));
vi.mock("@/components/system-health/MarketDataStatusPanel", () => ({ MarketDataStatusPanel: () => <div /> }));
vi.mock("@/components/system-health/HistoricalDataStatusPanel", () => ({ HistoricalDataStatusPanel: () => <div /> }));
vi.mock("@/components/system-health/StrategyEngineStatusPanel", () => ({
  StrategyEngineStatusPanel: () => <div data-testid="strategy-engine-status-panel" />,
}));
vi.mock("@/components/system-health/AIEngineActivityPanel", () => ({
  AIEngineActivityPanel: () => <div data-testid="legacy-strategy-simulator-activity-panel" />,
}));
vi.mock("@/components/system-health/VPSWorkerStatusPanel", () => ({
  VPSWorkerStatusPanel: () => <div data-testid="vps-worker-status-panel" />,
}));
vi.mock("@/components/system-health/TradingModeStatusPanel", () => ({
  TradingModeStatusPanel: () => <div data-testid="trading-mode-status-panel" />,
}));
vi.mock("@/components/system-health/HermesRegistryStatusPanel", () => ({
  HermesRegistryStatusPanel: () => <div data-testid="hermes-registry-status-panel" />,
}));
vi.mock("@/components/system-health/AIDecisionHistoryStatusPanel", () => ({
  AIDecisionHistoryStatusPanel: () => <div data-testid="ai-decision-history-status-panel" />,
}));

const { default: SystemHealthPage } = await import("@/app/system-health/page");

describe("Operations Centre (System Health) page", () => {
  it("shows a prominent, separate 'Hermes Agent & eToro Broker' section, distinct from every legacy panel", () => {
    render(<SystemHealthPage />);
    expect(screen.getByText("Hermes Agent & eToro Broker")).toBeInTheDocument();
    expect(screen.getByTestId("hermes-agent-status-panel")).toBeInTheDocument();
  });

  it("marks every legacy Strategy Simulator section as Developer-scoped, never as Hermes status", () => {
    render(<SystemHealthPage />);
    expect(screen.getByText("Legacy Strategy Simulator (Developer)")).toBeInTheDocument();
    expect(screen.getByText("Always-On Scanning (Developer)")).toBeInTheDocument();
    expect(screen.getByText("Trading Mode (Developer)")).toBeInTheDocument();
    expect(screen.getByText("Legacy Decision History (Developer)")).toBeInTheDocument();
  });

  it("no longer contains the stale, false 'no broker connection, no live execution' claim", () => {
    render(<SystemHealthPage />);
    expect(screen.queryByText(/no broker connection, no live execution/i)).not.toBeInTheDocument();
  });

  it("closing note correctly distinguishes the real Hermes/eToro demo connection from the separate legacy simulator", () => {
    render(<SystemHealthPage />);
    expect(screen.getByText(/real demo broker connection/i)).toBeInTheDocument();
    expect(screen.getByText(/no connection to hermes agent or etoro at all/i)).toBeInTheDocument();
  });
});
