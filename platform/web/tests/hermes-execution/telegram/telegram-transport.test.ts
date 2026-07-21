import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpTelegramTransport,
  TELEGRAM_API_BASE_URL,
  TelegramApiError,
} from "@/lib/hermes-execution/telegram/telegram-transport";

const BOT_TOKEN = "test-bot-token-value-123";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("HttpTelegramTransport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("calls the official Telegram API host with the bot token in the URL path only", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: [] }));
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    await transport.getUpdates(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TELEGRAM_API_BASE_URL}/bot${BOT_TOKEN}/getUpdates`);
    expect(JSON.stringify(init.headers)).not.toContain(BOT_TOKEN);
    expect(init.body).not.toContain(BOT_TOKEN);
  });

  it("never throws, logs, or returns the bot token from a request failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    let caught: unknown;
    try {
      await transport.getUpdates(0);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramApiError);
    expect(String(caught)).not.toContain(BOT_TOKEN);
    expect((caught as TelegramApiError).status).toBe(401);
  });

  it("getUpdates maps Telegram's raw snake_case shape to a flat TelegramUpdate", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        result: [
          { update_id: 42, message: { chat: { id: 555 }, from: { id: 777 }, text: "/status" } },
          { update_id: 43, message: { chat: { id: 555 } } },
        ],
      }),
    );
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    const updates = await transport.getUpdates(0);

    expect(updates).toEqual([
      { updateId: 42, chatId: "555", fromId: "777", text: "/status" },
      { updateId: 43, chatId: "555", fromId: undefined, text: undefined },
    ]);
  });

  it("getUpdates sends the given offset and Telegram's own long-poll timeout", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: [] }));
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    await transport.getUpdates(99);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.offset).toBe(99);
    expect(typeof body.timeout).toBe("number");
  });

  it("sendMessage posts chat_id and text to Telegram's sendMessage method", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: true }));
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    await transport.sendMessage("555", "hello world");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TELEGRAM_API_BASE_URL}/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "555", text: "hello world" });
  });

  it("throws a typed TelegramApiError — never a raw AbortError, and never the bot token — when the request hangs past its bound", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );
    const transport = new HttpTelegramTransport(BOT_TOKEN);
    const promise = transport.getUpdates(0);
    const timeoutPromise = vi.advanceTimersByTimeAsync(40_000);
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    await timeoutPromise;
    expect(caught).toBeInstanceOf(TelegramApiError);
    expect((caught as TelegramApiError).status).toBe("timeout");
    expect(String(caught)).not.toContain(BOT_TOKEN);
  });
});
