import type { OrderSizingMode } from "./types";

// Broker Sizing Semantic Fix. THE single calculation path for turning a raw (sizingMode, quantity,
// price) triple into a notional/exposure value — every cash-sufficiency check, strategy
// max-position-value check, and portfolio max-exposure check across both risk engines
// (risk-engine.ts, portfolio-risk-engine.ts) calls calculateNotional below, never `quantity * price`
// inline and never a scattered `broker === "etoro-demo"` string comparison. A broker's sizing mode
// is looked up once, in runtime-config/broker-capabilities.ts, and threaded through as typed data
// from there on.

const ORDER_SIZING_MODES: readonly OrderSizingMode[] = ["UNITS", "NOTIONAL"];

export function isOrderSizingMode(value: unknown): value is OrderSizingMode {
  return typeof value === "string" && (ORDER_SIZING_MODES as readonly string[]).includes(value);
}

/** Thrown whenever a sizing mode is missing, malformed, or simply not one of the two known values —
 * deliberately never silently defaulted to "NOTIONAL" or "UNITS". Every caller that receives a
 * sizing mode from outside this pipeline's own typed data flow (e.g. a persisted legacy
 * TradeCandidate row created before this field existed) must run it through assertOrderSizingMode
 * first; a candidate that fails this check is reported as a failure, never guessed at. */
export class UnknownOrderSizingModeError extends Error {
  constructor(
    public readonly received: unknown,
    context: string,
  ) {
    super(
      `Unknown or missing order sizing mode ${JSON.stringify(received)} for ${context} — refusing to guess ` +
        `UNITS or NOTIONAL semantics. This usually means a legacy record predates explicit sizing modes.`,
    );
    this.name = "UnknownOrderSizingModeError";
  }
}

export function assertOrderSizingMode(value: unknown, context: string): OrderSizingMode {
  if (!isOrderSizingMode(value)) {
    throw new UnknownOrderSizingModeError(value, context);
  }
  return value;
}

/**
 * The notional value of `quantity` units/amount at `price`, per `sizingMode`:
 * - "UNITS": quantity x price (a share/contract count priced at the market).
 * - "NOTIONAL": quantity, unchanged — it already IS the notional amount (eToro's CFD "amount").
 * `price` is accepted (not merely `quantity`) even for "NOTIONAL" so every call site has one uniform
 * signature regardless of mode — it is simply unused in that branch.
 */
export function calculateNotional(sizingMode: OrderSizingMode, quantity: number, price: number): number {
  switch (sizingMode) {
    case "UNITS":
      return quantity * price;
    case "NOTIONAL":
      return quantity;
    default: {
      const exhaustive: never = sizingMode;
      throw new UnknownOrderSizingModeError(exhaustive, "calculateNotional");
    }
  }
}
