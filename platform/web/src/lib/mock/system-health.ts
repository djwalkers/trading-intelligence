import type { MarketStatus, SystemService } from "@/lib/types";
import { isSupabaseConfigured } from "@/lib/persistence/config";

export const marketStatus: MarketStatus = {
  isOpen: true,
  label: "Markets open",
  nextEvent: "NYSE closes at 21:00 BST",
  timezone: "Europe/London",
};

export const systemServices: SystemService[] = [
  {
    id: "market-data",
    name: "Market Data",
    state: "mocked",
    detail: "Serving simulated prices. No live feed connected.",
  },
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
  {
    id: "persistence-mode",
    name: "Persistence Mode",
    state: "running",
    detail: "Local Browser Storage — paper trades are saved in this browser only.",
  },
  {
    id: "supabase",
    name: "Supabase",
    state: isSupabaseConfigured() ? "passive" : "not_connected",
    detail: `Supabase schema: Prepared (migrations in platform/web/supabase/migrations) · Supabase persistence: Disabled${
      isSupabaseConfigured() ? " · Environment variables detected" : ""
    }`,
  },
];
