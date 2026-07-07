export type SignalType = "BUY" | "SELL" | "HOLD";

export interface Signal {
  id: string;
  instrumentSymbol: string;
  instrumentName: string;
  signalType: SignalType;
  confidencePercent: number;
  strategyName: string;
  reason: string;
  timestamp: string;
}
