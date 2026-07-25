import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  advance,
  assistantMessages,
  composer,
  mountApp,
  pressEnter,
  sendButton,
  statusText,
  teardownApp,
  userMessages,
} from "./helpers/app-harness.js";

const WS_URL = "ws://chat.test:3001";

/** Boots the app against a server that accepts the connection. */
async function connectApp(): Promise<FakeWebSocket> {
  await mountApp({ wsUrl: WS_URL });
  const socket = FakeWebSocket.last;
  socket.acceptConnection();
  await advance(0);
  return socket;
}

describe("the transcript reassembles a chunked reply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("sends one message frame and grows a single bubble from its chunks", async () => {
    const socket = await connectApp();
    expect(statusText()).toBe("Online");

    pressEnter("what is a websocket?");

    expect(socket.sentMessages).toEqual([
      { type: "message", content: "what is a websocket?" },
    ]);
    expect(userMessages()).toEqual(["what is a websocket?"]);
    expect(composer().value).toBe("");
    expect(sendButton().disabled).toBe(true);

    socket.emit({ type: "chunk", requestId: "req-1", content: "A socket " });
    socket.emit({ type: "chunk", requestId: "req-1", content: "that stays " });

    // Mid-stream: still one bubble, growing, not one bubble per chunk.
    expect(assistantMessages()).toEqual(["A socket that stays "]);

    socket.emit({ type: "chunk", requestId: "req-1", content: "open." });
    socket.emit({ type: "done", requestId: "req-1" });

    expect(assistantMessages()).toEqual(["A socket that stays open."]);
    expect(userMessages()).toEqual(["what is a websocket?"]);
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent?.trim()).toBe("Send");
  });

  it("keeps interleaved requestIds in separate bubbles", async () => {
    const socket = await connectApp();

    pressEnter("two at once");

    socket.emit({ type: "chunk", requestId: "a", content: "first " });
    socket.emit({ type: "chunk", requestId: "b", content: "second " });
    socket.emit({ type: "chunk", requestId: "a", content: "answer" });
    socket.emit({ type: "chunk", requestId: "b", content: "answer" });
    socket.emit({ type: "done", requestId: "a" });
    socket.emit({ type: "done", requestId: "b" });

    // Keyed by requestId, in the order the streams opened -- not concatenated
    // into one bubble, and not shuffled.
    expect(assistantMessages()).toEqual(["first answer", "second answer"]);
  });

  it("unlocks the composer on the running stream's done, not on a stale one", async () => {
    const socket = await connectApp();

    pressEnter("hello");
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent?.trim()).toBe("Waiting for reply...");

    socket.emit({ type: "chunk", requestId: "live", content: "streaming" });

    // A `done` left over from an earlier request must not release the composer
    // while the live stream is still running.
    socket.emit({ type: "done", requestId: "stale-from-before-reconnect" });
    expect(sendButton().disabled).toBe(true);
    expect(assistantMessages()).toEqual(["streaming"]);

    socket.emit({ type: "done", requestId: "live" });
    expect(sendButton().disabled).toBe(false);

    // And the composer really is usable again -- a stuck flag would have made
    // every later send a no-op.
    pressEnter("second question");
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "hello" },
      { type: "message", content: "second question" },
    ]);
    expect(userMessages()).toEqual(["hello", "second question"]);
  });
});
