import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { computeSha256Hex, parseChecksumFile, type ArchiveLocation } from "./binance-archive";

// Phase 4 — Historical Dataset Intake. The ONE module in the Binance acquisition pipeline that
// performs network I/O — a plain `fetch` against Binance's own public archive host only, no
// credentials, no API key, identified by an explicit User-Agent. Every other module in this pipeline
// (binance-archive.ts, binance-zip.ts) is pure and network-free. Runs ONLY when the CLI is invoked
// directly by an operator — never during module import, `npm test`, or `npm run build`.

export interface DownloadOptions {
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
}

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  timeoutMs: 30_000,
  maxRetries: 3,
  userAgent: "Hermes-Execution-DatasetIntake/1 (offline research tool; no credentials; contact: repository operator)",
};

export type FetchBufferResult =
  | { ok: true; body: Buffer; status: number }
  | { ok: false; reason: "TIMEOUT" | "HTTP_ERROR" | "NETWORK_ERROR" | "RESPONSE_TOO_LARGE"; detail: string };

// Binance's own monthly 1h-kline ZIP (or its tiny .CHECKSUM sibling) is always far smaller than
// this — a fixed, safe upper bound on how much of a response this pipeline will ever hold in memory.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Reads a response body up to `maxBytes`, checking the declared `Content-Length` (if present) AND
 * the actual bytes streamed (never trusting a header alone) — a response that exceeds the bound is
 * rejected outright rather than buffered in full. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<{ ok: true; body: Buffer } | { ok: false; detail: string }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, detail: `declared Content-Length ${declaredLength} exceeds the ${maxBytes}-byte maximum` };
  }
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) return { ok: false, detail: `response body is ${buffer.length} byte(s), exceeding the ${maxBytes}-byte maximum` };
    return { ok: true, body: buffer };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, detail: `response body exceeded the ${maxBytes}-byte maximum` };
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}

/**
 * Bounded retry, explicit timeout, explicit User-Agent, no credentials/API keys/auth headers of any
 * kind. Retries only on network failures/timeouts/5xx responses — a 4xx (e.g. 404, meaning the
 * archive genuinely doesn't exist at this URL) fails IMMEDIATELY, never retried, since retrying
 * cannot change a "this file was never published" outcome and a missing archive must be reported,
 * never silently skipped. `redirect: "error"` means ANY HTTP redirect fails the request outright —
 * this pipeline trusts exactly one fixed host (data.binance.vision, see binance-archive.ts's own
 * `BINANCE_ARCHIVE_BASE_URL`) and never silently follows a redirect off of it. The response body is
 * read through `readBoundedBody`, never an unbounded `response.arrayBuffer()`.
 */
export async function fetchBuffer(url: string, options: DownloadOptions): Promise<FetchBufferResult> {
  let lastDetail = "";
  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": options.userAgent }, signal: AbortSignal.timeout(options.timeoutMs), redirect: "error" });
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, reason: "HTTP_ERROR", detail: `${url}: HTTP ${response.status} (client error — not retried)` };
      }
      if (!response.ok) {
        lastDetail = `${url}: HTTP ${response.status}`;
        continue;
      }
      const bodyResult = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      if (!bodyResult.ok) {
        return { ok: false, reason: "RESPONSE_TOO_LARGE", detail: `${url}: ${bodyResult.detail}` };
      }
      return { ok: true, body: bodyResult.body, status: response.status };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      lastDetail = `${url}: ${error instanceof Error ? error.message : String(error)}`;
      if (isTimeout && attempt === options.maxRetries) return { ok: false, reason: "TIMEOUT", detail: lastDetail };
    }
  }
  return { ok: false, reason: "NETWORK_ERROR", detail: `failed after ${options.maxRetries} attempt(s): ${lastDetail}` };
}

async function writeFileAtomically(filePath: string, content: Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function readFileIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface CachedArchiveResult {
  status: "reused" | "downloaded";
  zipPath: string;
  checksumPath: string;
  sha256: string;
}

export type DownloadArchiveResult = { ok: true; result: CachedArchiveResult } | { ok: false; reason: string; detail: string };

/**
 * Resumable: if a previously downloaded zip already exists on disk AND its own SHA-256 matches the
 * FRESHLY downloaded `.CHECKSUM` file (never a stale, locally-cached checksum), the existing file is
 * reused — no re-download. A cached file that fails that check is NEVER reused; the archive is
 * re-downloaded and re-verified from scratch. The checksum is always fetched fresh, every run — it is
 * tiny (~90 bytes) and is what makes the offline "is my cached copy still trustworthy" check honest
 * rather than merely checking the cached file against itself.
 */
export async function downloadAndVerifyArchive(location: ArchiveLocation, sourceDir: string, options: DownloadOptions): Promise<DownloadArchiveResult> {
  const zipPath = path.join(sourceDir, location.zipFileName);
  const checksumPath = path.join(sourceDir, location.checksumFileName);

  const checksumFetch = await fetchBuffer(location.checksumUrl, options);
  if (!checksumFetch.ok) return { ok: false, reason: checksumFetch.reason, detail: `checksum download failed: ${checksumFetch.detail}` };
  const checksumParsed = parseChecksumFile(checksumFetch.body.toString("utf-8"), location.zipFileName);
  if (!checksumParsed.ok) return { ok: false, reason: "INVALID_CHECKSUM_FILE", detail: checksumParsed.detail };
  const expectedSha256 = checksumParsed.sha256;

  const existing = await readFileIfExists(zipPath);
  if (existing !== undefined && computeSha256Hex(existing) === expectedSha256) {
    await writeFileAtomically(checksumPath, checksumFetch.body);
    return { ok: true, result: { status: "reused", zipPath, checksumPath, sha256: expectedSha256 } };
  }

  const zipFetch = await fetchBuffer(location.zipUrl, options);
  if (!zipFetch.ok) return { ok: false, reason: zipFetch.reason, detail: `archive download failed: ${zipFetch.detail}` };
  const actualSha256 = computeSha256Hex(zipFetch.body);
  if (actualSha256 !== expectedSha256) {
    return { ok: false, reason: "CHECKSUM_MISMATCH", detail: `${location.zipFileName}: downloaded archive sha256 ${actualSha256} does not match expected ${expectedSha256} — not written to disk` };
  }

  await writeFileAtomically(zipPath, zipFetch.body);
  await writeFileAtomically(checksumPath, checksumFetch.body);
  return { ok: true, result: { status: "downloaded", zipPath, checksumPath, sha256: expectedSha256 } };
}
