import { NextResponse } from "next/server";

// Hermes Integration API v1. One consistent envelope for every /api/hermes/* response — success
// and failure alike — so a caller (Hermes Agent) never has to branch on response shape beyond
// checking `ok`.

export interface HermesEnvelopeMeta {
  timestamp: string;
}

export interface HermesSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: HermesEnvelopeMeta;
}

export interface HermesErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  meta: HermesEnvelopeMeta;
}

export function successEnvelope<T>(data: T, status = 200): NextResponse<HermesSuccessEnvelope<T>> {
  return NextResponse.json({ ok: true, data, meta: { timestamp: new Date().toISOString() } }, { status });
}

/** `message` must always be a safe, human-readable string — never a raw Error object, a stack
 * trace, or anything sourced from a caught error's own `.stack`. Every call site in this codebase
 * passes a hand-written message or an upstream error's `.message` only (see auth.ts/broker-
 * snapshot.ts for examples), never the error itself. */
export function errorEnvelope(code: string, message: string, status: number): NextResponse<HermesErrorEnvelope> {
  return NextResponse.json({ ok: false, error: { code, message }, meta: { timestamp: new Date().toISOString() } }, { status });
}
