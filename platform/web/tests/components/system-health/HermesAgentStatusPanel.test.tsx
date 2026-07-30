import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { HermesAgentStatusPanel } from "@/components/system-health/HermesAgentStatusPanel";

// Legacy-worker UI cleanup — required tests: "Hermes Agent status, trading runtime status and
// eToro broker status are presented as three distinct concepts" and "no screen implies that a
// running trading runtime proves the official Nous Hermes Agent is healthy." This panel reuses
// the exact same useHermesDashboardData() hook (and therefore the exact same /api/dashboard/
// hermes-* endpoints) the Dashboard's own HermesPortfolioSection/HermesRuntimeStatusStrip already
// trust — never a second, competing source for Hermes status, and never derived from the legacy
// bot's own localStorage/Supabase state (this file imports no legacy hook at all).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function summaryBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      timestamp: "2026-07-30T12:00:00.000Z",
      health: { status: "healthy", runtimeMode: "demo", brokerProvider: "etoro-demo" },
      runtime: { state: "RUNNING", lastRunAt: "2026-07-30T11:55:00.000Z", successfulRunCount: 5, failedRunCount: 0 },
      openPositionCount: 2,
      latestDecision: { timestamp: "2026-07-30T11:55:00.000Z", symbol: "BTC", outcome: "BUY", confidence: 0.8 },
      recentFailure: null,
      unreconciledClosures: [],
      warnings: [],
      ...overrides,
    },
  };
}

const EMPTY_OK = { ok: true, data: {} };

function mockFetchSequence(handler: (path: string) => Response) {
  return vi.fn(async (input: string | URL | Request) => handler(String(input)));
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const originalFetch = global.fetch;

describe("HermesAgentStatusPanel", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders Hermes Agent, Trading runtime, and eToro broker as three distinct, separately-badged rows", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse(summaryBody());
      return jsonResponse(EMPTY_OK);
    }) as unknown as typeof fetch;

    render(<HermesAgentStatusPanel />);
    await flushMicrotasks();

    expect(screen.getByText("Hermes Agent")).toBeInTheDocument();
    expect(screen.getByText("Trading runtime")).toBeInTheDocument();
    expect(screen.getByText("eToro broker connection")).toBeInTheDocument();

    const agentBadge = screen.getByTestId("hermes-agent-observed-state");
    const runtimeBadge = screen.getByTestId("trading-runtime-observed-state");
    const brokerBadge = screen.getByTestId("etoro-broker-observed-state");

    // Three genuinely separate badges/testids — never one merged element standing in for all three.
    expect(agentBadge).not.toBe(runtimeBadge);
    expect(runtimeBadge).not.toBe(brokerBadge);
    expect(agentBadge).toHaveTextContent("Producing decisions");
    expect(runtimeBadge).toHaveTextContent("Running");
    expect(brokerBadge).toHaveTextContent("Connected");
  });

  it("never labels the Trading runtime row as Hermes Agent, and never derives Hermes Agent's badge from runtime.state", async () => {
    // Runtime is RUNNING, but a recent failure exists — proves Hermes Agent's own badge is NOT
    // simply mirroring runtime.state (which would otherwise also show healthy/teal here).
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse(
          summaryBody({
            runtime: { state: "RUNNING", lastRunAt: "2026-07-30T11:55:00.000Z", successfulRunCount: 5, failedRunCount: 1 },
            recentFailure: { eventType: "AGENT_PROPOSAL_FAILED", timestamp: "2026-07-30T11:56:00.000Z", message: "Hermes CLI call failed" },
          }),
        );
      }
      return jsonResponse(EMPTY_OK);
    }) as unknown as typeof fetch;

    render(<HermesAgentStatusPanel />);
    await flushMicrotasks();

    // The runtime process is genuinely running — that row correctly says so.
    expect(screen.getByTestId("trading-runtime-observed-state")).toHaveTextContent("Running");
    // But Hermes Agent's own row reflects the recorded failure, not the runtime's healthy state —
    // a running runtime never implies Hermes Agent itself is healthy.
    expect(screen.getByTestId("hermes-agent-observed-state")).toHaveTextContent("Degraded");
    expect(screen.getByText(/Hermes CLI call failed/)).toBeInTheDocument();
  });

  it("shows 'No decision yet' for Hermes Agent (never a fabricated healthy state) when nothing has been produced", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse(summaryBody({ latestDecision: null }));
      return jsonResponse(EMPTY_OK);
    }) as unknown as typeof fetch;

    render(<HermesAgentStatusPanel />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-agent-observed-state")).toHaveTextContent("No decision yet");
  });

  it("shows 'Paused'/'Stopped' trading-runtime states honestly, never as 'Running'", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse(summaryBody({ runtime: { state: "PAUSED", lastRunAt: null, successfulRunCount: 0, failedRunCount: 0 } }));
      }
      return jsonResponse(EMPTY_OK);
    }) as unknown as typeof fetch;

    render(<HermesAgentStatusPanel />);
    await flushMicrotasks();

    expect(screen.getByTestId("trading-runtime-observed-state")).toHaveTextContent("Paused");
  });

  it("shows 'Unavailable' for all three (never a fabricated healthy state) when the summary fetch fails", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "UPSTREAM", message: "boom" } }, 502)) as unknown as typeof fetch;

    render(<HermesAgentStatusPanel />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-agent-observed-state")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("trading-runtime-observed-state")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("etoro-broker-observed-state")).toHaveTextContent("Unavailable");
  });
});
