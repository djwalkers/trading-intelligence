import type { TradingRuntime } from "../runtime/trading-runtime";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import { formatHelp, formatPnl, formatPositions, formatStatus, formatTrades } from "./telegram-commands";
import type { TelegramTransport, TelegramUpdate } from "./telegram-transport";

// Prototype V1 — minimum operational Telegram bot. Long-polls for updates, authorizes every sender
// against exactly one configured chat id, and dispatches a small fixed set of commands — no
// conversational AI, no free-text handling beyond exact-match commands. Every command reuses
// TradingRuntime/TradeLifecycleStore directly (through the same interfaces market:runtime already
// depends on) — this file never recomputes P/L, risk, or decision logic, only reports it.

const RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TelegramBotDeps {
  transport: TelegramTransport;
  /** The one chat/user id this bot will ever act on — see TelegramConfig's own doc comment
   * (config.ts) for why this is a string, not a parsed number. */
  allowedChatId: string;
  runtime: TradingRuntime;
  lifecycleStore: TradeLifecycleStore;
}

export class TelegramBot {
  private polling = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: TelegramBotDeps) {}

  /** Idempotent — calling start() while already polling is a no-op, matching TradingRuntime's own
   * "one caller, one lifecycle" convention closely enough for this milestone's scope. */
  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  async sendAlert(text: string): Promise<void> {
    await this.deps.transport.sendMessage(this.deps.allowedChatId, text);
  }

  /** Exposed publicly (not just used internally by pollLoop) specifically so tests can exercise
   * authorization and command dispatch directly, one update at a time, without driving the actual
   * polling loop or any real waiting. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Ignore, never reply to, any sender other than the one configured chat id — "reject or ignore
    // every other sender." Silent rather than an explicit rejection reply, so this bot never even
    // confirms its own existence to an unauthorized prober.
    if (update.chatId !== this.deps.allowedChatId) return;

    const command = (update.text ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    switch (command) {
      case "/status":
        await this.reply(formatStatus(this.deps.runtime.getStatus()));
        return;
      case "/positions":
        await this.reply(formatPositions(await this.deps.lifecycleStore.listOpen()));
        return;
      case "/trades":
        await this.reply(formatTrades(await this.deps.lifecycleStore.listClosed()));
        return;
      case "/pnl":
        await this.reply(formatPnl(await this.deps.lifecycleStore.listClosed()));
        return;
      case "/pause":
        await this.runRuntimeAction(() => this.deps.runtime.pause(), "Paused.");
        return;
      case "/resume":
        await this.runRuntimeAction(() => this.deps.runtime.resume(), "Resumed.");
        return;
      case "/run":
        await this.handleRun();
        return;
      case "/help":
        await this.reply(formatHelp());
        return;
      default:
        // An unrecognised command or plain text — no reply. "No conversational AI in the bot": this
        // bot only ever responds to its own fixed, exact-match command set.
        return;
    }
  }

  private async reply(text: string): Promise<void> {
    await this.deps.transport.sendMessage(this.deps.allowedChatId, text);
  }

  private async runRuntimeAction(action: () => Promise<void>, successMessage: string): Promise<void> {
    try {
      await action();
      await this.reply(successMessage);
    } catch (error) {
      await this.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleRun(): Promise<void> {
    try {
      const outcome = await this.deps.runtime.runNow();
      await this.reply(`Cycle result: ${outcome.kind}`);
    } catch (error) {
      await this.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Classic long-poll loop: getUpdates() itself blocks server-side for up to ~25s whenever
   * there's nothing new (see telegram-transport.ts), which is the loop's own natural pacing — no
   * additional sleep between successful iterations. Only a transport failure (network error, non-
   * 2xx, or the transport's own request timeout) gets a fixed retry delay, so a persistent failure
   * degrades into a slow retry loop rather than hammering Telegram's API. */
  private async pollLoop(): Promise<void> {
    let offset = 0;
    while (this.polling) {
      try {
        const updates = await this.deps.transport.getUpdates(offset);
        for (const update of updates) {
          if (!this.polling) break;
          offset = Math.max(offset, update.updateId + 1);
          await this.handleUpdate(update);
        }
      } catch {
        if (this.polling) await sleep(RETRY_DELAY_MS);
      }
    }
  }
}
