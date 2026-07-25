import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  advance,
  assistantMessages,
  composer,
  mountApp,
  pressEnter,
  queuedMessage,
  queuedNote,
  retryButton,
  sendButton,
  statusText,
  systemMessages,
  teardownApp,
  userMessages,
} from "./helpers/app-harness.js";

const WS_URL = "ws://chat.test:3001";

/** Longer than the whole reconnect budget: 1+2+4+8+16s of waiting plus 5 x 3s attempts. */
const PAST_THE_RETRY_BUDGET_MS = 60_000;

const allSystemText = (): string => systemMessages().join(" | ");

describe("Enter before the transport is ready never loses the text", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("queues a message typed while connecting and sends it on open", async () => {
    await mountApp({ wsUrl: WS_URL });
    const socket = FakeWebSocket.last;
    expect(statusText()).toBe("Connecting...");

    pressEnter("typed before the socket opened");

    // Taken out of the composer, so it has to be visible somewhere else.
    expect(composer().value).toBe("");
    expect(queuedMessage()).toBe("typed before the socket opened");
    expect(queuedNote()).toContain("Queued");
    expect(sendButton().textContent?.trim()).toBe("Queued...");
    expect(sendButton().disabled).toBe(true);

    // Not committed to the transcript and not on the wire yet.
    expect(userMessages()).toEqual([]);
    expect(socket.sent).toEqual([]);

    socket.acceptConnection();
    await advance(0);

    // The whole point: it actually goes out, exactly once.
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "typed before the socket opened" },
    ]);
    expect(userMessages()).toEqual(["typed before the socket opened"]);
    expect(queuedMessage()).toBeNull();
    expect(sendButton().textContent?.trim()).toBe("Waiting for reply...");

    socket.emit({ type: "chunk", requestId: "r1", content: "answer" });
    socket.emit({ type: "done", requestId: "r1" });
    expect(assistantMessages()).toEqual(["answer"]);
  });

  it("hands a queued message back when the reconnect budget runs out", async () => {
    await mountApp({ wsUrl: WS_URL });
    FakeWebSocket.last.acceptConnection();
    await advance(0);

    FakeWebSocket.last.dropConnection();
    expect(statusText()).toBe("Offline (reconnecting...)");

    pressEnter("do not lose me");
    expect(queuedMessage()).toBe("do not lose me");
    expect(composer().value).toBe("");

    await advance(PAST_THE_RETRY_BUDGET_MS);

    // Bounded: the first connection plus five retries, then it stops.
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(statusText()).toBe("Server unavailable");

    // Nothing may be left waiting on a connection that will never come.
    expect(queuedMessage()).toBeNull();
    expect(composer().value).toBe("do not lose me");
    expect(userMessages()).toEqual([]);
    expect(allSystemText()).toContain("back in the composer");
    expect(retryButton().hidden).toBe(false);
    expect(sendButton().textContent?.trim()).toBe("Send");
  });

  it("refuses to send once the server is unavailable, keeping the text", async () => {
    await mountApp({ wsUrl: WS_URL });
    FakeWebSocket.last.acceptConnection();
    await advance(0);
    FakeWebSocket.last.dropConnection();
    await advance(PAST_THE_RETRY_BUDGET_MS);
    expect(statusText()).toBe("Server unavailable");

    const socketsBefore = FakeWebSocket.instances.length;
    pressEnter("typed after it gave up");

    // Refused, not swallowed: the text stays put and no orphan user turn is
    // added to a transcript that will never get a reply.
    expect(composer().value).toBe("typed after it gave up");
    expect(userMessages()).toEqual([]);
    expect(queuedMessage()).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(socketsBefore);
    expect(allSystemText()).toContain("Not sent");
    expect(allSystemText()).toContain("Retry server");
  });

  it("refuses a second message mid-reply, keeping the text", async () => {
    await mountApp({ wsUrl: WS_URL });
    const socket = FakeWebSocket.last;
    socket.acceptConnection();
    await advance(0);

    pressEnter("first");
    socket.emit({ type: "chunk", requestId: "r1", content: "still going" });

    pressEnter("second, typed mid-reply");

    expect(composer().value).toBe("second, typed mid-reply");
    expect(userMessages()).toEqual(["first"]);
    expect(socket.sentMessages).toEqual([{ type: "message", content: "first" }]);
    expect(allSystemText()).toContain("A reply is still streaming");

    // Once the reply lands, the preserved text sends normally.
    socket.emit({ type: "done", requestId: "r1" });
    pressEnter(composer().value);

    expect(userMessages()).toEqual(["first", "second, typed mid-reply"]);
    expect(socket.sentMessages).toHaveLength(2);
  });
});
