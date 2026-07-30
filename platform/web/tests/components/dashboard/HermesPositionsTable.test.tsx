import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HermesPositionsTable } from "@/components/dashboard/HermesPositionsTable";
import type { HermesPositionItem } from "@/lib/hermes-dashboard/types";

// Main Dashboard Hermes/eToro fix — requirement 4 (positions section) and requirement 9's own test
// list ("empty positions render correctly", "instrument IDs map to friendly symbols" — the mapping
// itself happens server-side in broker-snapshot.ts, already covered by
// tests/hermes-integration/broker-snapshot.test.ts; this file proves the table displays whatever
// instrument string it is given, verbatim, never re-deriving or garbling it).

function makePosition(overrides: Partial<HermesPositionItem> = {}): HermesPositionItem {
  return {
    instrument: "BTC",
    brokerInstrumentId: 100_000,
    side: "BUY",
    quantity: 9.95,
    units: 9.95,
    entryPrice: 64_208.29,
    currentPrice: null,
    unrealisedPnl: null,
    pricingTimestamp: null,
    pricingSource: "unavailable",
    pricingFailureReason: null,
    openedAt: "2026-07-29T15:18:00.000Z",
    provider: "etoro-demo",
    accountMode: "demo",
    brokerPositionId: null,
    ...overrides,
  };
}

describe("HermesPositionsTable", () => {
  it("renders an empty state when there are no open positions — never an empty/broken table", () => {
    render(<HermesPositionsTable positions={[]} />);
    expect(screen.getByTestId("hermes-positions-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("hermes-position-row")).not.toBeInTheDocument();
  });

  it("renders one row per position with every required field", () => {
    render(<HermesPositionsTable positions={[makePosition()]} />);
    const row = screen.getByTestId("hermes-position-row");
    expect(row).toHaveTextContent("BTC");
    expect(row).toHaveTextContent("BUY");
    expect(row).toHaveTextContent("9.95");
    expect(row).toHaveTextContent("$64,208.29");
    expect(row).toHaveTextContent("etoro-demo");
    expect(row).toHaveTextContent("demo");
  });

  it("shows an already-mapped friendly symbol verbatim (the mapping itself happens server-side)", () => {
    render(<HermesPositionsTable positions={[makePosition({ instrument: "ETH" })]} />);
    expect(screen.getByTestId("hermes-position-row")).toHaveTextContent("ETH");
  });

  it("shows a raw numeric instrument id verbatim when the broker adapter could not map it — never hides or fabricates a symbol", () => {
    render(<HermesPositionsTable positions={[makePosition({ instrument: "999999" })]} />);
    expect(screen.getByTestId("hermes-position-row")).toHaveTextContent("999999");
  });

  it("shows 'Unavailable' for a position whose live price could not be fetched — never £0.00 or $0.00", () => {
    render(<HermesPositionsTable positions={[makePosition({ currentPrice: null, unrealisedPnl: null, pricingSource: "unavailable" })]} />);
    const row = screen.getByTestId("hermes-position-row");
    expect(row).toHaveTextContent("Unavailable");
    expect(row.textContent).not.toContain("$0.00");
    expect(row.textContent).not.toContain("£");
  });

  it("shows the real current price and unrealised P/L when the position was successfully priced", () => {
    render(
      <HermesPositionsTable
        positions={[makePosition({ currentPrice: 65_000, unrealisedPnl: 78.71, pricingSource: "broker" })]}
      />,
    );
    const row = screen.getByTestId("hermes-position-row");
    expect(row).toHaveTextContent("$65,000.00");
    expect(row).toHaveTextContent("$78.71");
  });

  it("renders multiple positions as multiple rows", () => {
    render(<HermesPositionsTable positions={[makePosition({ instrument: "BTC" }), makePosition({ instrument: "ETH" })]} />);
    expect(screen.getAllByTestId("hermes-position-row")).toHaveLength(2);
  });

  it("shows an 'unknown' side badge without throwing when the broker reports an ambiguous direction", () => {
    render(<HermesPositionsTable positions={[makePosition({ side: "unknown" })]} />);
    expect(screen.getByTestId("hermes-position-row")).toHaveTextContent("unknown");
  });
});
