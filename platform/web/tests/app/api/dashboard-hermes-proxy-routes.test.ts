import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// Main Dashboard Hermes/eToro fix. Each browser-facing proxy route is a one-line wrapper around
// proxyHermesGet (already thoroughly tested in tests/hermes-integration/dashboard-proxy.test.ts) —
// these tests only confirm each route wires the correct upstream path, nothing more. Split-
// deployment fix: proxyHermesGet no longer takes a NextRequest (it no longer derives the upstream
// host from the incoming request's own origin — see dashboard-proxy.ts), so these routes' own GET
// handlers now take no arguments either.

const proxyHermesGetMock = vi.hoisted(() => vi.fn(async () => NextResponse.json({ ok: true, data: {} })));
vi.mock("@/lib/hermes-integration/dashboard-proxy", () => ({ proxyHermesGet: proxyHermesGetMock }));

describe("dashboard Hermes proxy routes", () => {
  it("GET /api/dashboard/hermes-portfolio proxies to 'portfolio'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-portfolio/route");
    await GET();
    expect(proxyHermesGetMock).toHaveBeenCalledWith("portfolio");
  });

  it("GET /api/dashboard/hermes-positions proxies to 'positions'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-positions/route");
    await GET();
    expect(proxyHermesGetMock).toHaveBeenCalledWith("positions");
  });

  it("GET /api/dashboard/hermes-summary proxies to 'summary'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-summary/route");
    await GET();
    expect(proxyHermesGetMock).toHaveBeenCalledWith("summary");
  });
});
