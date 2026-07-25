import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  advance,
  assistantMessages,
  mountApp,
  pressEnter,
  retryButton,
  statusText,
  systemMessages,
  teardownApp,
  transcript,
  userMessages,
} from "./helpers/app-harness.js";

/** A configured server that is simply gone -- the dead Render host case. */
const DEAD_WS_URL = "wss://chat-gpt-pq6b.onrender.com";

/** The deadline a single connection attempt gets, from `ws-transport.ts`. */
const OPEN_TIMEOUT_MS = 3000;

describe("an unreachable WS_URL falls back to the in-browser transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("gives up within the attempt deadline and says which server failed", async () => {
    await mountApp({ wsUrl: DEAD_WS_URL });

    // The socket hangs in CONNECTING, exactly like a host that no longer exists.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.url).toBe(DEAD_WS_URL);
    expect(statusText()).toBe("Connecting...");

    // The deadline elapses, then the fallback transport opens on the next tick.
    await advance(OPEN_TIMEOUT_MS);
    await advance(1);

    // No permanent spinner: the demo transport is live and the chat works.
    expect(statusText()).toBe("Demo mode - server unreachable");

    // The degradation is visible and names the culprit, instead of looking
    // like a deliberate demo.
    const notice = systemMessages().find((line) => line.includes(DEAD_WS_URL));
    expect(notice).toBeDefined();
    expect(notice).toContain("Could not reach the WebSocket server");
    expect(notice).toContain("Falling back to the in-browser demo transport");
    expect(notice).toContain("WS_URL points at a running server");

    // Retry stays on screen, so the real server can still be tried.
    expect(retryButton().hidden).toBe(false);
    expect(retryButton().textContent?.trim()).toBe("Retry server");

    // One attempt only -- a dead host must not start an endless retry loop.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.sent).toEqual([]);

    // And the fallback is a working chat, not a read-only notice.
    pressEnter("still works?");
    await vi.runAllTimersAsync();
    expect(userMessages()).toEqual(["still works?"]);
    expect(assistantMessages()).toHaveLength(1);
    expect(assistantMessages()[0]).toContain('You asked: "still works?"');
  });

  it("comes back to the real server when Retry finds it alive", async () => {
    await mountApp({ wsUrl: DEAD_WS_URL });
    await advance(OPEN_TIMEOUT_MS);
    await advance(1);
    expect(statusText()).toBe("Demo mode - server unreachable");

    retryButton().click();
    await advance(0);

    expect(FakeWebSocket.instances).toHaveLength(2);
    const socket = FakeWebSocket.last;
    socket.acceptConnection();
    await advance(0);

    expect(statusText()).toBe("Online");
    expect(retryButton().hidden).toBe(true);

    // The chat now runs over the socket: the disposed demo transport must not
    // answer as well, or every question would get two replies.
    pressEnter("over the socket");
    expect(socket.sentMessages).toEqual([
      { type: "message", content: "over the socket" },
    ]);

    await vi.runAllTimersAsync();
    expect(assistantMessages()).toEqual([]);

    socket.emit({ type: "chunk", requestId: "r1", content: "from the server" });
    socket.emit({ type: "done", requestId: "r1" });
    expect(assistantMessages()).toEqual(["from the server"]);
    expect(transcript()).not.toContain("You asked:");
  });
});
