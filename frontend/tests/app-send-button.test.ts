import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  advance,
  clickSend,
  composer,
  mountApp,
  queuedMessage,
  sendButton,
  statusText,
  systemText,
  teardownApp,
  userMessages,
} from "./helpers/app-harness.js";

const WS_URL = "ws://chat.test:3001";

/** Longer than the whole reconnect budget: 1+2+4+8+16s of waiting plus 5 x 3s attempts. */
const PAST_THE_RETRY_BUDGET_MS = 60_000;

/**
 * Every send outcome used to be reachable by keyboard only. While the app was
 * connecting, reconnecting or unavailable the button was greyed out, and a
 * disabled button dispatches no click at all -- so a pointer or touch user,
 * who has no Enter key, could not send, could not queue, and was told nothing.
 */
describe("Send is a live control whenever pressing it means something", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("queues a click made while the socket is still connecting", async () => {
    await mountApp({ wsUrl: WS_URL });
    const socket = FakeWebSocket.last;
    expect(statusText()).toBe("Connecting...");

    expect(sendButton().disabled).toBe(false);
    expect(sendButton().title).toContain("queued");

    clickSend("sent with the mouse while connecting");

    expect(composer().value).toBe("");
    expect(queuedMessage()).toBe("sent with the mouse while connecting");
    expect(userMessages()).toEqual([]);
    expect(socket.sent).toEqual([]);

    // Now disabled -- but with a label that says why, which is the difference.
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent?.trim()).toBe("Queued...");

    socket.acceptConnection();
    await advance(0);

    expect(socket.sentMessages).toEqual([
      { type: "message", content: "sent with the mouse while connecting" },
    ]);
    expect(userMessages()).toEqual(["sent with the mouse while connecting"]);
    expect(queuedMessage()).toBeNull();
  });

  it("stays clickable once the server is unavailable and refuses out loud", async () => {
    await mountApp({ wsUrl: WS_URL });
    FakeWebSocket.last.acceptConnection();
    await advance(0);
    FakeWebSocket.last.dropConnection();
    await advance(PAST_THE_RETRY_BUDGET_MS);
    expect(statusText()).toBe("Server unavailable");

    expect(sendButton().disabled).toBe(false);
    expect(sendButton().title).toContain("Retry server");

    clickSend("typed after it gave up");

    // The refusal is the whole value of the click here: the text is kept and
    // the user is pointed at Retry, instead of a grey button explaining nothing.
    expect(systemText()).toContain("Not sent");
    expect(systemText()).toContain("Retry server");
    expect(composer().value).toBe("typed after it gave up");
    expect(userMessages()).toEqual([]);
  });

  it("sends on click and hands focus back to the composer", async () => {
    await mountApp({ wsUrl: WS_URL });
    const socket = FakeWebSocket.last;
    socket.acceptConnection();
    await advance(0);

    clickSend("sent with the mouse");

    expect(socket.sentMessages).toEqual([
      { type: "message", content: "sent with the mouse" },
    ]);
    expect(userMessages()).toEqual(["sent with the mouse"]);
    expect(composer().value).toBe("");

    // Clicking takes focus off the composer; the next message must not need a
    // second trip to the mouse to type.
    expect(document.activeElement).toBe(composer());
  });
});
