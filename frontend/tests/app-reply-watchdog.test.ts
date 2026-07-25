import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  advance,
  assistantMessages,
  mountApp,
  pressEnter,
  sendButton,
  statusText,
  systemText,
  teardownApp,
  userMessages,
} from "./helpers/app-harness.js";

const WS_URL = "ws://chat.test:3001";

/** The silence deadline from `app.ts`, in ms. */
const REPLY_SILENCE_TIMEOUT_MS = 20_000;

/** Boots the app against a server that accepts the connection. */
async function connectApp(): Promise<FakeWebSocket> {
  await mountApp({ wsUrl: WS_URL });
  const socket = FakeWebSocket.last;
  socket.acceptConnection();
  await advance(0);
  return socket;
}

/**
 * The failure mode these cover is a socket that stays open while the server
 * behind it stops answering: no close event, no error, just silence. Every
 * signal the app has says "connected", so nothing else in the code can notice.
 */
describe("a server that goes quiet does not strand the composer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("bounds the wait when an open socket never answers at all", async () => {
    const socket = await connectApp();

    pressEnter("anyone there?");
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "anyone there?" },
    ]);
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent?.trim()).toBe("Waiting for reply...");

    // A slow server is not a dead one: nothing is given up on early.
    await advance(REPLY_SILENCE_TIMEOUT_MS - 1000);
    expect(sendButton().disabled).toBe(true);
    expect(systemText()).not.toContain("No reply came back");

    await advance(1500);

    // The socket never closed, so the pill stays honest -- but the app stops
    // claiming a reply is on its way, which it did forever before the deadline.
    expect(statusText()).toBe("Online");
    expect(systemText()).toContain("No reply came back within 20 seconds");
    expect(assistantMessages()).toEqual([]);
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent?.trim()).toBe("Send");

    // Released for real, not just re-enabled: the next message reaches the wire.
    pressEnter("second try");
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "anyone there?" },
      { type: "message", content: "second try" },
    ]);
    expect(userMessages()).toEqual(["anyone there?", "second try"]);
  });

  it("keeps a half-streamed reply, and each chunk restarts the deadline", async () => {
    const socket = await connectApp();

    pressEnter("tell me about sockets");
    await advance(10_000);
    socket.emit({ type: "chunk", requestId: "r1", content: "A socket stays " });

    // Past the deadline measured from the send, but the chunk restarted it:
    // a reply still trickling in must never be abandoned mid-flight.
    await advance(15_000);
    expect(sendButton().disabled).toBe(true);
    expect(systemText()).not.toContain("stopped part-way");

    // Now the silence itself outlasts the deadline.
    await advance(6000);

    expect(statusText()).toBe("Online");
    expect(systemText()).toContain("stopped part-way through");
    // What did arrive is kept above, not discarded with the stream.
    expect(assistantMessages()).toEqual(["A socket stays "]);
    expect(sendButton().disabled).toBe(false);

    pressEnter("go on");
    expect(socket.sentMessages).toHaveLength(2);
  });

  it("treats an error frame as the end of the stream, not a pause in it", async () => {
    const socket = await connectApp();

    pressEnter("what went wrong?");
    socket.emit({ type: "chunk", requestId: "r1", content: "Starting to answ" });
    socket.emit({ type: "error", error: "Upstream request failed." });

    expect(systemText()).toContain("Upstream request failed.");
    expect(assistantMessages()).toEqual(["Starting to answ"]);
    expect(sendButton().disabled).toBe(false);

    // The abandoned stream must not leave a deadline running, or the app would
    // later apologise for a reply nobody is waiting for any more.
    await advance(REPLY_SILENCE_TIMEOUT_MS + 5000);
    expect(systemText()).not.toContain("No reply came back");
    expect(systemText()).not.toContain("stopped part-way");

    // The real regression: a stream left open refused every later send with
    // "a reply is still streaming" while no reply was ever coming.
    pressEnter("try again");
    expect(systemText()).not.toContain("A reply is still streaming");
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "what went wrong?" },
      { type: "message", content: "try again" },
    ]);
    expect(userMessages()).toEqual(["what went wrong?", "try again"]);
  });
});
