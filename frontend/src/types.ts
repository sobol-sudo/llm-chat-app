export interface WSMessage {
  type: "ping" | "message" | "chunk" | "done" | "error" | "system";
  requestId?: string;
  content?: string;
  error?: string;
  ts?: number;
}

export interface OutgoingMessage {
  type: "ping" | "message";
  requestId?: string;
  content?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  streamId?: string | null;
  isSystem?: boolean;
}

export interface ActiveStream {
  index: number;
  content: string;
}

/** Which implementation is currently carrying the chat protocol. */
export type TransportKind = "websocket" | "local";

/**
 * Lifecycle of a transport.
 * - connecting: the first attempt is in flight
 * - open: ready to send and receive
 * - reconnecting: dropped, a bounded retry schedule is running
 * - unavailable: retry budget exhausted, manual retry required
 */
export type TransportState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unavailable";

export interface TransportHandlers {
  onMessage: (msg: WSMessage) => void;
  onStateChange: (state: TransportState, kind: TransportKind) => void;
}

/**
 * The chat protocol is transport-agnostic: the UI only ever sees `WSMessage`
 * values, whether they arrive from a WebSocket server or are produced locally.
 */
export interface ChatTransport {
  readonly kind: TransportKind;
  readonly isOpen: boolean;
  send(msg: OutgoingMessage): boolean;
  dispose(): void;
}

declare global {
  interface Window {
    ENV?: {
      WS_URL?: string;
    };
  }
}
