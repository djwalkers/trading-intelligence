import "server-only";
import * as fs from "node:fs/promises";
import type { Candle } from "./types";

function isValidCandle(value: unknown): value is Candle {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.symbol === "string" &&
    typeof c.timestamp === "string" &&
    !Number.isNaN(Date.parse(c.timestamp)) &&
    typeof c.open === "number" &&
    typeof c.high === "number" &&
    typeof c.low === "number" &&
    typeof c.close === "number" &&
    typeof c.volume === "number"
  );
}

/** Reads and validates a local JSON candle fixture. Never touches the network — the only I/O is
 * a single local file read, which is what makes replaying it in a test or the demo CLI repeatable. */
export async function loadFixtureCandles(filePath: string): Promise<Candle[]> {
  const text = await fs.readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture candle file ${filePath} must contain a JSON array`);
  }
  const invalidIndex = parsed.findIndex((item) => !isValidCandle(item));
  if (invalidIndex !== -1) {
    throw new Error(`Fixture candle file ${filePath} has an invalid candle at index ${invalidIndex}`);
  }
  return parsed as Candle[];
}
