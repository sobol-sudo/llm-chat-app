/**
 * A deployed static build: no WS_URL is configured and the page is not served
 * from a dev host.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://llm-chat-app.example/" }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./helpers/fake-websocket.js";
import {
  assistantMessages,
  mountApp,
  pressEnter,
  retryButton,
  statusText,
  systemMessages,
  teardownApp,
  userMessages,
} from "./helpers/app-harness.js";

describe("with no server configured the app is a demo, not a failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    teardownApp();
    vi.useRealTimers();
  });

  it("dials nothing, says Demo mode, and hides Retry", async () => {
    await mountApp({ wsUrl: "" });

    // Guessing ws://localhost:3001 from a deployed page would be a connection
    // that can only ever fail.
    expect(FakeWebSocket.instances).toEqual([]);

    expect(statusText()).toBe("Demo mode");

    // Retry with nothing to retry against would be exactly the dead control
    // this app is not allowed to have.
    expect(retryButton().hidden).toBe(true);

    // Nothing failed, so nothing may claim a failure.
    expect(systemMessages()).toHaveLength(1);
    expect(systemMessages()[0]).toContain("Local demo mode");
    expect(systemMessages()[0]).not.toContain("Could not reach");

    pressEnter("hello");
    await vi.runAllTimersAsync();

    expect(userMessages()).toEqual(["hello"]);
    expect(assistantMessages()[0]).toContain('You asked: "hello"');
  });
});
