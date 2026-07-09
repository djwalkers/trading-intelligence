import "server-only";

// The browser's reserveScanId() (src/lib/bot/scan-id.ts) is a localStorage counter — it has no
// meaning in a Node worker process (typeof window === "undefined" there), and returns the same
// fixed "SCAN-000001" for every call in that environment, which would be wrong here: every worker
// scan needs its own id. This is a worker-local, in-memory counter instead, namespaced by process
// id so two worker processes never produce the same id even if started at the same instant. It
// doesn't need to be globally sequential across every browser and worker for the same user —
// Mission 6's advisory lock (src/lib/scheduler/server-schedule-store.ts) already guarantees at
// most one scan ever runs for a given user at a time, so there is no concurrent-write scenario for
// two scan ids to collide against.
let counter = 0;

export function reserveWorkerScanId(): string {
  counter += 1;
  return `WORKER-${process.pid}-${String(counter).padStart(6, "0")}`;
}
