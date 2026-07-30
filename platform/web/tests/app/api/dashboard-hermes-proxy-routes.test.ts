import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Main Dashboard Hermes/eToro fix. Each browser-facing proxy route is a one-line wrapper around
// proxyHermesGet (already thoroughly tested in tests/hermes-integration/dashboard-proxy.test.ts) —
// these tests only confirm each route wires the correct upstream path, nothing more.

const proxyHermesGetMock = vi.hoisted(() => vi.fn(async () => NextResponse.json({ ok: true, data: {} })));
vi.mock("@/lib/hermes-integration/dashboard-proxy", () => ({ proxyHermesGet: proxyHermesGetMock }));

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`);
}

describe("dashboard Hermes proxy routes", () => {
  it("GET /api/dashboard/hermes-portfolio proxies to 'portfolio'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-portfolio/route");
    await GET(makeRequest("/api/dashboard/hermes-portfolio"));
    expect(proxyHermesGetMock).toHaveBeenCalledWith(expect.anything(), "portfolio");
  });

  it("GET /api/dashboard/hermes-positions proxies to 'positions'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-positions/route");
    await GET(makeRequest("/api/dashboard/hermes-positions"));
    expect(proxyHermesGetMock).toHaveBeenCalledWith(expect.anything(), "positions");
  });

  it("GET /api/dashboard/hermes-summary proxies to 'summary'", async () => {
    const { GET } = await import("@/app/api/dashboard/hermes-summary/route");
    await GET(makeRequest("/api/dashboard/hermes-summary"));
    expect(proxyHermesGetMock).toHaveBeenCalledWith(expect.anything(), "summary");
  });
});
