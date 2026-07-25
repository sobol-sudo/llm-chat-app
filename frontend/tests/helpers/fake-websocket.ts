/**
 * A WebSocket stand-in the tests drive by hand.
 *
 * Nothing here connects to anything: a socket stays in CONNECTING until the
 * test calls `open()`, which is what lets us reproduce "typed while connecting"
 * and "configured server never answers" deterministically.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket the code under test constructed, oldest first. */
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  /** The socket most recently constructed, i.e. the current attempt. */
  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error("No WebSocket was constructed");
    return socket;
  }

  readyState: number = FakeWebSocket.CONNECTING;

  /** Raw frames the app wrote to this socket. */
  readonly sent: string[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Frames the app wrote, parsed. */
  get sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("Tried to send on a socket that is not open");
    }
    this.sent.push(data);
  }

  close(): void {
    const wasOpen = this.readyState === FakeWebSocket.OPEN;
    this.readyState = FakeWebSocket.CLOSED;
    // A client-side close is not a server drop; the transport detaches its
    // handlers before calling close(), so mirror that and stay quiet.
    if (wasOpen && this.onclose && this.notifyOnClientClose) this.onclose();
  }

  /** Set only by tests that want close() to look like a drop. */
  notifyOnClientClose = false;

  /** The server accepted the connection. */
  acceptConnection(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The server (or the network) dropped an established connection. */
  dropConnection(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** The connection attempt was refused. */
  refuseConnection(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }

  /** Deliver one protocol frame from the server. */
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Deliver a raw payload, valid JSON or not. */
  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }
}
