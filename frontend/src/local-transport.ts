import type {
  ChatTransport,
  OutgoingMessage,
  TransportHandlers,
} from "./types.js";
import { generateReply } from "./reply-generator.js";

/** Same chunking parameters the WebSocket backend streams with. */
const CHUNK_SIZE = 18;
const CHUNK_DELAY_MS = 80;

/**
 * Describes the transport only. Why it is in use -- no server configured, or a
 * configured one that did not answer -- is reported by the caller, which is the
 * only place that knows.
 */
const SYSTEM_GREETING =
  "Local demo mode: replies are generated in your browser and streamed in " +
  "chunks over the same protocol the WebSocket backend uses.";

function createRequestId(): string {
  const cryptoRef = globalThis.crypto;

  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }

  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-browser implementation of the chat protocol.
 *
 * It emits exactly the messages the WebSocket server emits -- a `system`
 * greeting on open, then `chunk` messages keyed by `requestId` followed by a
 * `done` -- so the UI's streaming state machine runs unchanged.
 */
export class LocalTransport implements ChatTransport {
  readonly kind = "local" as const;

  private opened = false;
  private disposed = false;
  private readonly timers = new Set<number>();

  constructor(private readonly handlers: TransportHandlers) {}

  get isOpen(): boolean {
    return this.opened && !this.disposed;
  }

  /** Opens on the next tick so callers can subscribe before anything arrives. */
  start(): void {
    if (this.disposed) return;

    this.schedule(() => {
      if (this.disposed) return;
      this.opened = true;
      this.handlers.onStateChange("open", this.kind);
      this.handlers.onMessage({ type: "system", content: SYSTEM_GREETING });
    }, 0);
  }

  send(msg: OutgoingMessage): boolean {
    if (!this.isOpen) return false;

    if (msg.type === "ping") {
      this.schedule(() => {
        this.handlers.onMessage({ type: "system", content: "pong" });
      }, 0);
      return true;
    }

    if (msg.type !== "message") return true;

    const requestId = msg.requestId || createRequestId();
    const fullText = generateReply(msg.content ?? "");

    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    }

    let index = 0;

    const sendNextChunk = (): void => {
      if (!this.isOpen) return;

      if (index < chunks.length) {
        this.handlers.onMessage({
          type: "chunk",
          requestId,
          content: chunks[index],
        });
        index += 1;
        this.schedule(sendNextChunk, CHUNK_DELAY_MS);
        return;
      }

      this.handlers.onMessage({ type: "done", requestId });
    };

    this.schedule(sendNextChunk, CHUNK_DELAY_MS);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.opened = false;
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers.clear();
  }

  private schedule(fn: () => void, delay: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delay);
    this.timers.add(id);
  }
}
