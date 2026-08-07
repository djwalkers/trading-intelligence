// Runtime Processes panel — Operations Centre. The one, narrow DTO shape this feature ever sends
// to the browser for PM2 process health — deliberately does not include anything from PM2's own
// pm2_env object (working directory, exec path, args, or its own `env` sub-object, which is where
// real environment variables/secrets would live) beyond the handful of fields explicitly listed
// below. See map-pm2-processes.ts for the one place this is constructed.

export type RuntimeProcessStatus = "online" | "stopped" | "errored" | "launching" | "unknown";

export interface RuntimeProcessView {
  /** Stable, app-defined identifier — never PM2's own pm_id (that changes across restarts). */
  key: string;
  /** Human-friendly display name, e.g. "Trading Intelligence Web". */
  name: string;
  /** The exact PM2 process name this view was matched against — one of MONITORED_PROCESSES' own
   * pm2Name values, never anything PM2 itself reported beyond confirming a match. */
  pm2Name: string;
  /** False when PM2's own process list did not include this process at all (never installed,
   * crashed out of PM2 entirely, or PM2 itself unreachable) — distinct from a genuinely "stopped"
   * process, which PM2 still lists. */
  available: boolean;
  pm2Id: number | null;
  status: RuntimeProcessStatus;
  /** Milliseconds since this process's own last (re)start — null whenever status isn't "online"
   * or "launching" (an uptime figure would be misleading for anything else) or PM2 didn't report
   * a start time at all. */
  uptimeMs: number | null;
  restartCount: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface RuntimeProcessesData {
  processes: RuntimeProcessView[];
  timestamp: string;
}
