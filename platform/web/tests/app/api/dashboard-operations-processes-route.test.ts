import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// Split-deployment defect fix. GET /api/dashboard/operations-processes is the browser-facing
// counterpart to the VPS-only PM2 collector (/api/operations/processes) — mirrors
// tests/app/api/dashboard-hermes-proxy-routes.test.ts's own convention exactly: proxyOperationsProcessesGet
// itself is already thoroughly tested in tests/hermes-integration/dashboard-proxy.test.ts, so this
// test only confirms the route wires to it with no arguments.

const proxyOperationsProcessesGetMock = vi.hoisted(() => vi.fn(async () => NextResponse.json({ ok: true, data: { processes: [] } })));
vi.mock("@/lib/hermes-integration/dashboard-proxy", () => ({ proxyOperationsProcessesGet: proxyOperationsProcessesGetMock }));

describe("GET /api/dashboard/operations-processes", () => {
  it("proxies to proxyOperationsProcessesGet with no arguments", async () => {
    const { GET } = await import("@/app/api/dashboard/operations-processes/route");
    await GET();
    expect(proxyOperationsProcessesGetMock).toHaveBeenCalledWith();
  });
});
