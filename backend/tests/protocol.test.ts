/**
 * The server end of the chunk-streaming protocol.
 *
 * The frontend tests drive a fake socket, so they can only prove that the UI
 * assembles frames correctly -- never that the server emits the frames it
 * assumes. This runs the real built server as its own process and talks to it
 * over a real WebSocket, which is the only place the contract between the two
 * packages is actually checked: one requestId per reply, chunks before the
 * single terminating `done`, nothing after it.
 *
 * `npm test` builds first, so the process under test is always the current src.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

/** Chunk size the server slices with, mirrored by `frontend/src/local-transport.ts`. */
const CHUNK_SIZE = 18;

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(backendDir, "dist", "server.js");

interface Frame {
  type: string;
  requestId?: string;
  content?: string;
  error?: string;
  ts?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the OS for a port nobody is using, so parallel runs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Could not read a port from the probe socket"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

let server: ChildProcess;
let port: number;
let serverLog = "";

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(
        `Server exited with code ${server.exitCode}. Output:\n${serverLog}`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(50);
  }
  throw new Error(`Server never became healthy. Output:\n${serverLog}`);
}

/** A client that records every frame the server sends, in arrival order. */
class Client {
  readonly frames: Frame[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw: Buffer) => {
      this.frames.push(JSON.parse(raw.toString("utf8")) as Frame);
    });
  }

  static connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const client = new Client(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.socket.send(data);
  }

  /** Resolves with the first recorded frame matching `predicate`. */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    label: string
  ): Promise<Frame> {
    for (let waited = 0; waited < 20_000; waited += 20) {
      const match = this.frames.find(predicate);
      if (match) return match;
      await sleep(20);
    }
    throw new Error(
      `Timed out waiting for ${label}. Got: ${this.frames
        .map((f) => f.type)
        .join(", ")}`
    );
  }

  close(): void {
    this.socket.close();
  }
}

let client: Client | null = null;

describe("the server streams a reply as one correlated chunk sequence", () => {
  beforeAll(async () => {
    port = await freePort();
    server = spawn(process.execPath, [serverEntry], {
      cwd: backendDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
    server.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));
    await waitForServer();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  afterAll(() => {
    server?.kill("SIGKILL");
  });

  it("greets on connect, then answers with chunks under one id and a final done", async () => {
    client = await Client.connect();

    const greeting = await client.waitFor((f) => f.type === "system", "greeting");
    expect(greeting.content).toContain("WebSocket connected");

    client.send({ type: "message", content: "how does streaming work?" });
    await client.waitFor((f) => f.type === "done", "done");

    const [first, ...rest] = client.frames;
    expect(first.type).toBe("system");

    const body = rest.slice(0, -1);
    const last = rest[rest.length - 1];

    // Ordering: every chunk arrives before the one terminating `done`.
    expect(body.length).toBeGreaterThan(1);
    expect(body.every((f) => f.type === "chunk")).toBe(true);
    expect(last.type).toBe("done");
    expect(rest.filter((f) => f.type === "done")).toHaveLength(1);

    // Correlation: a fresh id per chunk would draw one bubble per chunk.
    const requestId = body[0].requestId;
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toBe("");
    expect(body.every((f) => f.requestId === requestId)).toBe(true);
    expect(last.requestId).toBe(requestId);

    // Assembly: exact slicing, so nothing is dropped or repeated at a boundary.
    const assembled = body.map((f) => f.content ?? "").join("");
    expect(assembled).toContain('You asked: "how does streaming work?"');
    const sizes = body.map((f) => (f.content ?? "").length);
    expect(sizes.slice(0, -1).every((n) => n === CHUNK_SIZE)).toBe(true);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(0);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(CHUNK_SIZE);
    expect(body).toHaveLength(Math.ceil(assembled.length / CHUNK_SIZE));

    // `done` really is terminal: a trailing frame would reopen a closed stream.
    const settled = client.frames.length;
    await sleep(300);
    expect(client.frames).toHaveLength(settled);
  });

  it("reports an unparseable frame as an error and keeps the connection usable", async () => {
    client = await Client.connect();
    await client.waitFor((f) => f.type === "system", "greeting");

    client.sendRaw("this is not json");

    // The frontend clears the active stream on `error`; if the server answered
    // a bad frame with silence instead, the composer would just hang.
    const error = await client.waitFor((f) => f.type === "error", "error");
    expect(error.error).toContain("JSON is expected");

    // One bad frame must not take the socket down with it.
    client.send({ type: "ping" });
    const pong = await client.waitFor((f) => f.type === "pong", "pong");
    expect(typeof pong.ts).toBe("number");
  });
});
