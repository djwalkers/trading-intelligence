import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BotDecisionLogProvider } from "@/lib/state/bot-decision-log-context";
import { BotDecisionsView } from "@/components/bot/BotDecisionsView";
import type { BotDecision } from "@/lib/bot";

const STORAGE_KEY = "trading-intelligence.bot-decisions.v5";

const SNAPSHOT = {
  totalOpenTrades: 0,
  totalCapitalDeployed: 0,
  availableCash: 10_000,
  startingCapital: 10_000,
  capitalByInstrument: {},
  capitalBySide: { BUY: 0, SELL: 0 },
  countBySide: { BUY: 0, SELL: 0 },
  capitalBySector: {},
  countBySector: {},
};

function buildDecision(overrides: Partial<BotDecision> = {}): BotDecision {
  return {
    id: "decision-1",
    scanId: "SCAN-000001",
    timestamp: new Date().toISOString(),
    triggerType: "Manual",
    instrumentsScanned: ["AAPL"],
    candidates: [],
    portfolioSnapshotBefore: SNAPSHOT,
    selectedInstrument: null,
    selectedInstrumentName: null,
    actionTaken: "No Trade",
    reason: "No tradeable candidates this scan.",
    trace: [],
    tradeCreated: false,
    executionTimeMs: 12.3,
    ...overrides,
  };
}

// Build 1.13.0 — the scenario Build 1.12.2 added `isHydrated` to guard against: a consumer must
// never show "no decisions yet" before the deferred localStorage read has actually resolved, and
// must show existing persisted decisions correctly once it has.
describe("BotDecisionsView hydration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders existing persisted decisions after hydration", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([buildDecision()]));

    render(
      <BotDecisionLogProvider>
        <BotDecisionsView />
      </BotDecisionLogProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Scan #1/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/has not completed any scans yet/)).not.toBeInTheDocument();
  });

  it("renders the empty state only after hydration completes, with no key present", async () => {
    render(
      <BotDecisionLogProvider>
        <BotDecisionsView />
      </BotDecisionLogProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/has not completed any scans yet/)).toBeInTheDocument();
    });
  });
});
