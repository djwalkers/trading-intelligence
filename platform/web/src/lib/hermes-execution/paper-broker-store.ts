import type { Account, CompletedTrade, PaperPosition } from "./types";

export interface PaperBrokerState {
  account: Account;
  openPositions: PaperPosition[];
  completedTrades: CompletedTrade[];
  nextOrderSeq: number;
  nextPositionSeq: number;
  nextTradeSeq: number;
}

export function initialPaperBrokerState(startingCash: number): PaperBrokerState {
  return {
    account: { cashBalance: startingCash, startingCashBalance: startingCash },
    openPositions: [],
    completedTrades: [],
    nextOrderSeq: 0,
    nextPositionSeq: 0,
    nextTradeSeq: 0,
  };
}

/** The persistence adapter LocalPaperBroker reads/writes through — swap the implementation
 * without touching any broker/risk/signal logic (same "clean adapter" pattern as RegistryClient). */
export interface PaperBrokerStore {
  load(): Promise<PaperBrokerState | null>;
  save(state: PaperBrokerState): Promise<void>;
}

/** Fully isolated, no fs access — used by tests so runs never share state or touch disk. */
export class InMemoryPaperBrokerStore implements PaperBrokerStore {
  private state: PaperBrokerState | null = null;

  async load(): Promise<PaperBrokerState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: PaperBrokerState): Promise<void> {
    this.state = structuredClone(state);
  }
}
