import type { RuntimeProcessStatus, RuntimeProcessView } from "./types";

// Runtime Processes panel — Operations Centre. THE one place raw `pm2 jlist` output is turned into
// the narrow DTO this app ever sends to the browser. Pure, no I/O — the caller (the API route) is
// responsible for actually running `pm2 jlist` and JSON.parse-ing its stdout; this function only
// ever receives the already-parsed (but still fully untrusted) result.
//
// Security discipline: every field on the returned view is read individually, by name, with a
// type check — never `{ ...entry }`, never `{ ...entry.pm2_env }`, never any object spread of raw
// PM2 output at all. PM2's own pm2_env carries exec paths, cwd, node args, and its own nested `env`
// object (the real environment variables a process was started with, potentially including
// secrets this app's own service-role/broker/integration credentials) — none of that is ever read
// here, let alone forwarded.

/** Hard allow-list — the ONLY two PM2 process names this feature will ever report on, regardless
 * of what else `pm2 jlist` returns (including the legacy `trading-intelligence-worker`, which must
 * never appear in this UI). Order here is the order processes are returned in. */
export const MONITORED_PROCESSES = [
  { key: "web", name: "Trading Intelligence Web", pm2Name: "trading-intelligence-web" },
  { key: "hermes-runtime", name: "Hermes Market Runtime", pm2Name: "hermes-market-runtime" },
] as const;

const PM2_STATUS_MAP: Record<string, RuntimeProcessStatus> = {
  online: "online",
  stopped: "stopped",
  errored: "errored",
  launching: "launching",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Never assumes an unrecognised PM2 status string means "online" or any other specific state —
 * falls back to "unknown" (the same safe fallback a missing/malformed status produces) rather than
 * guessing. PM2's own real status vocabulary is wider than this app displays (e.g. "stopping",
 * "waiting restart", "one-launch-status") — deliberately collapsed to "unknown" rather than
 * inventing a display for states this UI was never asked to distinguish. */
function mapStatus(value: unknown): RuntimeProcessStatus {
  if (typeof value !== "string") return "unknown";
  return PM2_STATUS_MAP[value] ?? "unknown";
}

export type MapPm2ProcessesResult = { ok: true; processes: RuntimeProcessView[] } | { ok: false; reason: string };

/**
 * `raw` is the JSON.parse of `pm2 jlist`'s stdout — expected shape is an array of process objects,
 * but this is subprocess output, so nothing about that shape is trusted. Returns `{ok:false}` only
 * when the TOP-LEVEL structure itself can't be interpreted as a process list at all (not an array).
 * A monitored process PM2 doesn't report, or a process entry with missing/malformed individual
 * fields, is never a failure of the whole call — it's represented per-process (see
 * RuntimeProcessView.available and the individual nullable metric fields).
 */
export function mapPm2ProcessesToOperationsView(raw: unknown, now: Date): MapPm2ProcessesResult {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "PM2 output was not a JSON array — cannot interpret the process list." };
  }

  const byPm2Name = new Map<string, Record<string, unknown>>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = entry.name;
    if (typeof name !== "string") continue;
    byPm2Name.set(name, entry);
  }

  const processes: RuntimeProcessView[] = MONITORED_PROCESSES.map((monitored) => {
    const entry = byPm2Name.get(monitored.pm2Name);
    if (!entry) {
      return {
        key: monitored.key,
        name: monitored.name,
        pm2Name: monitored.pm2Name,
        available: false,
        pm2Id: null,
        status: "unknown",
        uptimeMs: null,
        restartCount: null,
        cpuPercent: null,
        memoryBytes: null,
      };
    }

    const pm2Env = isRecord(entry.pm2_env) ? entry.pm2_env : {};
    const monit = isRecord(entry.monit) ? entry.monit : {};

    const status = mapStatus(pm2Env.status);
    // pm_uptime is an ABSOLUTE epoch-ms start time, never a duration — only meaningful (and only
    // shown) while the process is actually running; a stopped/errored process's own last start
    // time would misleadingly read as "how long it's been up" if shown unconditionally.
    const pmUptime = toFiniteNumber(pm2Env.pm_uptime);
    const uptimeMs = (status === "online" || status === "launching") && pmUptime !== null ? now.getTime() - pmUptime : null;

    return {
      key: monitored.key,
      name: monitored.name,
      pm2Name: monitored.pm2Name,
      available: true,
      pm2Id: toFiniteNumber(pm2Env.pm_id),
      status,
      uptimeMs,
      restartCount: toFiniteNumber(pm2Env.restart_time),
      cpuPercent: toFiniteNumber(monit.cpu),
      memoryBytes: toFiniteNumber(monit.memory),
    };
  });

  return { ok: true, processes };
}
