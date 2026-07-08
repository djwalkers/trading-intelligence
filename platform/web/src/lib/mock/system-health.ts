import type { MarketStatus, SystemService } from "@/lib/types";

export const marketStatus: MarketStatus = {
  isOpen: true,
  label: "Markets open",
  nextEvent: "NYSE closes at 21:00 BST",
  timezone: "Europe/London",
};

export const systemServices: SystemService[] = [
  {
    id: "broker-api",
    name: "Broker API",
    state: "not_connected",
    detail: "No broker integration configured for this prototype.",
  },
  {
    id: "database",
    name: "Database",
    state: "not_connected",
    detail: "Persistence layer not yet provisioned.",
  },
  {
    id: "strategy-engine",
    name: "Strategy Engine",
    state: "running",
    detail: "Evaluating mock strategies against mock market data.",
  },
  {
    id: "risk-engine",
    name: "Risk Engine",
    state: "passive",
    detail: "Monitoring only. No position limits are enforced yet.",
  },
  {
    id: "execution-engine",
    name: "Execution Engine",
    state: "disabled",
    detail: "Order execution is disabled. No trades can be placed.",
  },
];
