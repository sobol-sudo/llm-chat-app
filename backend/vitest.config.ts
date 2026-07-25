import { defineConfig } from "vitest/config";

/**
 * The server is an integration test target: each run starts the built server as
 * a real process and talks to it over a real socket, so the timeouts have to
 * cover a full streamed reply (~20-70 chunks, 80ms apart) plus process startup.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
