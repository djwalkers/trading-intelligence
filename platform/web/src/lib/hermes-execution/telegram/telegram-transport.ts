// Prototype V1 — minimum direct Telegram integration. A thin, single-purpose fetch wrapper around
// Telegram's official Bot API (api.telegram.org) — no SDK, no webhook server, no REST API of our
// own (per the mission's "keep this simple" constraint). Long-polling (getUpdates) is used instead
// of a webhook specifically because it needs no publicly reachable HTTPS endpoint — this process
// simply asks Telegram for new messages periodically.
//
// Deliberately never logs or serialises the bot token — it appears only in the URL path of each
// request (never a header, never a body field, never included in any returned/thrown value here).

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** A single incoming message, already normalised out of Telegram's raw wire shape (snake_case,
 * deeply nested `message.chat.id`/`message.from.id`) — everything downstream of the transport only
 * ever sees this flat shape. `text` is undefined for a non-text message (a sticker, a photo, ...) —
 * TelegramBot treats that the same as an unrecognised command, not a crash. */
export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  fromId: string | undefined;
  text: string | undefined;
}

export interface TelegramTransport {
  /** Long-polls for new updates strictly after `offset`. Resolves with an empty array if none
   * arrive within Telegram's own long-poll window — never rejects for "no updates," only for a
   * genuine transport failure (network error, non-2xx response, or this transport's own bounded
   * timeout). */
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

/** Thrown for both a timed-out request and a non-2xx Telegram API response — deliberately never
 * includes the bot token (which only ever appears in the request URL, never read back out here) or
 * any other request detail beyond the HTTP method/status needed to diagnose a failure. */
export class TelegramApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number | "timeout",
  ) {
    super(
      status === "timeout"
        ? `Telegram ${operation} timed out.`
        : `Telegram ${operation} failed with HTTP status ${status}.`,
    );
    this.name = "TelegramApiError";
  }
}

// Telegram's own long-poll convention: the server holds the connection open for up to this many
// seconds waiting for a new update before responding with an empty result — not a claim about how
// often this process itself decides to re-poll (see TelegramBot's own pollIntervalMs).
const LONG_POLL_TIMEOUT_SECONDS = 25;
// A request-level bound independent of the long-poll window above — guards against the HTTP
// request itself hanging (e.g. a stalled connection), the same reliability concern that motivated
// EtoroClient's own bounded timeout. Comfortably longer than the long-poll window so a legitimate
// 25s long-poll is never mistaken for a stalled request.
const REQUEST_TIMEOUT_MS = (LONG_POLL_TIMEOUT_SECONDS + 10) * 1_000;

interface RawTelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}

/** The real implementation — used only by market-runtime.ts, never by tests (which always inject a
 * fake TelegramTransport; see the mission's own "no real Telegram messages in automated tests"
 * requirement). */
export class HttpTelegramTransport implements TelegramTransport {
  constructor(private readonly botToken: string) {}

  private async request<T>(operation: string, method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TelegramApiError(operation, "timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new TelegramApiError(operation, response.status);
    }
    return (await response.json()) as T;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const result = await this.request<{ result: RawTelegramUpdate[] }>("getUpdates", "getUpdates", {
      offset,
      timeout: LONG_POLL_TIMEOUT_SECONDS,
    });
    return result.result.map((raw) => ({
      updateId: raw.update_id,
      chatId: String(raw.message?.chat.id ?? ""),
      fromId: raw.message?.from ? String(raw.message.from.id) : undefined,
      text: raw.message?.text,
    }));
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.request("sendMessage", "sendMessage", { chat_id: chatId, text });
  }
}
