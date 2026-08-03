import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArchiveLocation, computeSha256Hex } from "@/lib/hermes-execution/dataset-intake/binance-archive";
import { downloadAndVerifyArchive, fetchBuffer, type DownloadOptions } from "@/lib/hermes-execution/dataset-intake/binance-downloader";

// Phase 4 — Historical Dataset Intake. Downloader tests — `fetch` is ALWAYS mocked here; this suite
// never makes a real network call, matching the task's own "tests must never access the network"
// requirement.

const FAST_OPTIONS: DownloadOptions = { timeoutMs: 500, maxRetries: 2, userAgent: "test-agent" };

function checksumText(hash: string, fileName: string): string {
  return `${hash}  ${fileName}\n`;
}

function jsonResponse(body: Buffer | string, status = 200): Response {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  return new Response(new Uint8Array(buffer), { status });
}

describe("fetchBuffer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the response body on success, sending the declared user agent and no credentials", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
      expect(init?.headers).not.toHaveProperty("Authorization");
      return jsonResponse("hello");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/x", FAST_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.toString("utf-8")).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on a 4xx response, never retrying", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("not found", 404));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/missing", FAST_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("HTTP_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a bounded number of times on a 5xx response, then fails", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("server error", 503));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/x", FAST_OPTIONS);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(FAST_OPTIONS.maxRetries);
  });

  it("succeeds after a transient failure followed by a success, within the retry bound", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt === 1) return jsonResponse("server error", 503);
      return jsonResponse("ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/x", FAST_OPTIONS);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests with redirect: 'error' — never silently follows a redirect off the trusted host", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return jsonResponse("hello");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/x", FAST_OPTIONS);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response whose declared Content-Length exceeds the maximum body size, without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(Buffer.from("small")), { status: 200, headers: { "content-length": "999999999" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuffer("https://data.binance.vision/x", FAST_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("RESPONSE_TOO_LARGE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("downloadAndVerifyArchive", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "binance-download-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("downloads, verifies, and caches a new archive", async () => {
    const location = buildArchiveLocation("BTCUSDT", "2024-01");
    const zipBytes = Buffer.from("fake-zip-content");
    const sha256 = computeSha256Hex(zipBytes);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === location.checksumUrl) return jsonResponse(checksumText(sha256, location.zipFileName));
      if (url === location.zipUrl) return jsonResponse(zipBytes);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await downloadAndVerifyArchive(location, dir, FAST_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.status).toBe("downloaded");
    expect((await fs.readFile(path.join(dir, location.zipFileName))).equals(zipBytes)).toBe(true);
  });

  it("rejects a checksum mismatch and never writes the bad file to disk", async () => {
    const location = buildArchiveLocation("BTCUSDT", "2024-02");
    const zipBytes = Buffer.from("fake-zip-content");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === location.checksumUrl) return jsonResponse(checksumText("f".repeat(64), location.zipFileName));
      if (url === location.zipUrl) return jsonResponse(zipBytes);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await downloadAndVerifyArchive(location, dir, FAST_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CHECKSUM_MISMATCH");
    await expect(fs.access(path.join(dir, location.zipFileName))).rejects.toThrow();
  });

  it("rejects a missing checksum file (fetch failure)", async () => {
    const location = buildArchiveLocation("BTCUSDT", "2024-03");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === location.checksumUrl) return jsonResponse("not found", 404);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await downloadAndVerifyArchive(location, dir, FAST_OPTIONS);
    expect(result.ok).toBe(false);
  });

  it("reuses an existing, verified cached archive without re-downloading the zip (resumable)", async () => {
    const location = buildArchiveLocation("BTCUSDT", "2024-04");
    const zipBytes = Buffer.from("already-cached-content");
    const sha256 = computeSha256Hex(zipBytes);
    await fs.writeFile(path.join(dir, location.zipFileName), zipBytes);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === location.checksumUrl) return jsonResponse(checksumText(sha256, location.zipFileName));
      throw new Error(`zip should never be re-downloaded when the cached copy already verifies; got request for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await downloadAndVerifyArchive(location, dir, FAST_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.status).toBe("reused");
    expect(fetchMock).toHaveBeenCalledTimes(1); // checksum only, never the zip
  });

  it("never reuses a corrupted cached archive — re-downloads instead", async () => {
    const location = buildArchiveLocation("BTCUSDT", "2024-05");
    const corruptBytes = Buffer.from("corrupted-stale-content");
    const realBytes = Buffer.from("the-real-content");
    const sha256 = computeSha256Hex(realBytes);
    await fs.writeFile(path.join(dir, location.zipFileName), corruptBytes);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === location.checksumUrl) return jsonResponse(checksumText(sha256, location.zipFileName));
      if (url === location.zipUrl) return jsonResponse(realBytes);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await downloadAndVerifyArchive(location, dir, FAST_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.status).toBe("downloaded");
    expect((await fs.readFile(path.join(dir, location.zipFileName))).equals(realBytes)).toBe(true);
  });
});
