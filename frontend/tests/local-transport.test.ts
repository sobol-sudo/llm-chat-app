import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTransport } from "../src/local-transport.js";
import { generateReply } from "../src/reply-generator.js";
import type { TransportHandlers, WSMessage } from "../src/types.js";

/** Same value the WebSocket backend chunks with (`backend/src/server.ts`). */
const CHUNK_SIZE = 18;

type LogEntry =
  | { kind: "state"; state: string; transport: string }
  | { kind: "frame"; frame: WSMessage };

function recorder(): { log: LogEntry[]; handlers: TransportHandlers } {
  const log: LogEntry[] = [];

  return {
    log,
    handlers: {
      onMessage: (frame) => log.push({ kind: "frame", frame }),
      onStateChange: (state, transport) =>
        log.push({ kind: "state", state, transport }),
    },
  };
}

const framesOf = (log: LogEntry[]): WSMessage[] =>
  log.flatMap((entry) => (entry.kind === "frame" ? [entry.frame] : []));

describe("LocalTransport speaks the chunk-streaming protocol", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The reply text is random by design; pin it so chunk boundaries and the
    // reassembled string are exactly comparable.
    vi.spyOn(Math, "random").mockReturnValue(0.42);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports open before it says anything, and greets exactly once", async () => {
    const { log, handlers } = recorder();
    const transport = new LocalTransport(handlers);

    transport.start();
    expect(log).toEqual([]);
    expect(transport.isOpen).toBe(false);

    await vi.advanceTimersByTimeAsync(0);

    expect(log[0]).toEqual({ kind: "state", state: "open", transport: "local" });
    expect(log[1]?.kind).toBe("frame");
    expect(framesOf(log)).toHaveLength(1);
    expect(framesOf(log)[0].type).toBe("system");
    expect(transport.isOpen).toBe(true);

    transport.dispose();
  });

  it("streams one requestId: chunks in order, a single done, nothing after it", async () => {
    const { log, handlers } = recorder();
    const transport = new LocalTransport(handlers);

    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    log.length = 0;

    expect(transport.send({ type: "message", content: "hello" })).toBe(true);
    await vi.runAllTimersAsync();

    const frames = framesOf(log);
    expect(frames.length).toBeGreaterThan(1);

    const last = frames[frames.length - 1];
    const body = frames.slice(0, -1);

    // Ordering: every chunk arrives before the single terminating `done`.
    expect(body.every((f) => f.type === "chunk")).toBe(true);
    expect(last.type).toBe("done");
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);

    // Correlation: one id ties the whole stream together.
    const requestId = frames[0].requestId;
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toBe("");
    expect(frames.every((f) => f.requestId === requestId)).toBe(true);
  });

  it("reassembles to exactly the generated reply, framed at 18 characters", async () => {
    const { log, handlers } = recorder();
    const transport = new LocalTransport(handlers);

    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    log.length = 0;

    transport.send({ type: "message", content: "how does streaming work?" });
    await vi.runAllTimersAsync();

    const chunks = framesOf(log).filter((f) => f.type === "chunk");
    const assembled = chunks.map((f) => f.content ?? "").join("");

    // Math.random is pinned, so the generator is reproducible.
    expect(assembled).toBe(generateReply("how does streaming work?"));
    expect(assembled).toContain('You asked: "how does streaming work?"');

    // Off-by-one slicing would still "look streamed" but drop characters.
    const sizes = chunks.map((f) => (f.content ?? "").length);
    expect(sizes.slice(0, -1).every((n) => n === CHUNK_SIZE)).toBe(true);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(0);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(CHUNK_SIZE);
    expect(chunks).toHaveLength(Math.ceil(assembled.length / CHUNK_SIZE));
  });

  it("stops mid-stream on dispose and leaves no timers behind", async () => {
    const { log, handlers } = recorder();
    const transport = new LocalTransport(handlers);

    transport.start();
    await vi.advanceTimersByTimeAsync(0);

    transport.send({ type: "message", content: "hello" });
    await vi.advanceTimersByTimeAsync(160);
    log.length = 0;

    // Retry disposes the standing transport; a disposed one must not keep
    // writing into the transcript of the session that replaced it.
    transport.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.runAllTimersAsync();
    expect(framesOf(log)).toEqual([]);
    expect(transport.isOpen).toBe(false);
  });
});
