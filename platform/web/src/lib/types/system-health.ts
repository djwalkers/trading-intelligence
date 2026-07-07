export type ServiceState =
  | "mocked"
  | "not_connected"
  | "running"
  | "passive"
  | "disabled";

export interface SystemService {
  id: string;
  name: string;
  state: ServiceState;
  detail: string;
}

export interface MarketStatus {
  isOpen: boolean;
  label: string;
  nextEvent: string;
  timezone: string;
}
