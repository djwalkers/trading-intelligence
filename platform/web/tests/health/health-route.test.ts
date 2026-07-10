import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns the documented shape with a 200 status under normal conditions", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(healthy|degraded|unavailable|unknown)$/),
      version: expect.any(String),
      timestamp: expect.any(String),
      services: {
        application: "healthy",
        automation: "unknown",
      },
    });
    // Never present regardless of environment — this is the core "no secrets in the health
    // response" guarantee.
    expect(JSON.stringify(body)).not.toMatch(/SERVICE_ROLE|API_KEY|apikey/i);
  });

  it("never returns a stack trace or raw exception text", async () => {
    const response = await GET();
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("at Object.");
    expect(JSON.stringify(body)).not.toContain(".ts:");
  });
});
