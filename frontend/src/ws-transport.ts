import type {
  ChatTransport,
  OutgoingMessage,
  TransportHandlers,
  WSMessage,
} from "./types.js";

/** How long a single connection attempt may stay in CONNECTING. */
export const OPEN_TIMEOUT_MS = 3000;

/** Bounded reconnect schedule: 1s, 2s, 4s, 8s, 16s (capped at 30s). */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;

function detach(socket: WebSocket): void {
  socket.onopen = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.onmessage = null;
}

/**
 * WebSocket implementation of the chat protocol.
 *
 * `start()` performs a single attempt with a hard deadline and reports whether
 * it succeeded, so the caller can fall back to another transport instead of
 * leaving the user on a spinner. Only once a connection has been established
 * does the bounded reconnect schedule take over; when the budget is exhausted
 * the transport settles into `unavailable` rather than retrying forever.
 */
export class WebSocketTransport implements ChatTransport {
  readonly kind = "websocket" as const;

  private ws: WebSocket | null = null;
  private disposed = false;
  private retrying = false;
  private retryTimer: number | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: TransportHandlers
  ) {}

  get isOpen(): boolean {
    return !this.disposed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Runs one connection attempt. Resolves `true` once the socket is open. */
  start(timeoutMs: number = OPEN_TIMEOUT_MS): Promise<boolean> {
    this.handlers.onStateChange("connecting", this.kind);
    return this.connectOnce(timeoutMs);
  }

  send(msg: OutgoingMessage): boolean {
    if (!this.isOpen || !this.ws) return false;

    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error("WS send error:", e);
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retrying = false;

    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const socket = this.ws;
    this.ws = null;

    if (socket) {
      detach(socket);
      try {
        socket.close();
      } catch (e) {
        console.error("WS close error:", e);
      }
    }
  }

  private connectOnce(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.disposed) {
        resolve(false);
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (e) {
        console.error("WS connect error:", e);
        resolve(false);
        return;
      }

      this.ws = socket;

      let settled = false;
      const settle = (opened: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);

        if (!opened) {
          detach(socket);
          try {
            socket.close();
          } catch (e) {
            console.error("WS close error:", e);
          }
          if (this.ws === socket) this.ws = null;
        }

        resolve(opened);
      };

      const timer = window.setTimeout(() => settle(false), timeoutMs);

      socket.onopen = () => {
        // Once open, a later close is a drop rather than a failed attempt.
        socket.onclose = () => {
          if (this.ws !== socket) return;
          this.ws = null;
          this.handleDrop();
        };
        if (!this.disposed) this.handlers.onStateChange("open", this.kind);
        settle(true);
      };

      socket.onclose = () => settle(false);

      socket.onerror = () => {
        // `close` always follows `error`; the state change is handled there.
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          this.handlers.onMessage(msg);
        } catch (e) {
          console.error("WS message error:", e);
        }
      };
    });
  }

  private handleDrop(): void {
    if (this.disposed || this.retrying) return;
    this.retrying = true;
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      if (this.disposed) return;

      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        RECONNECT_MAX_DELAY_MS
      );

      this.handlers.onStateChange("reconnecting", this.kind);
      await this.wait(delay);
      if (this.disposed) return;

      this.handlers.onStateChange("connecting", this.kind);
      const opened = await this.connectOnce(OPEN_TIMEOUT_MS);
      if (this.disposed) return;

      if (opened) {
        this.retrying = false;
        return;
      }
    }

    this.retrying = false;
    if (!this.disposed) {
      this.handlers.onStateChange("unavailable", this.kind);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        resolve();
      }, ms);
    });
  }
}
