import { defineConfig } from "vitest/config";

/**
 * Kept separate from `vite.config.ts` so the production build config stays
 * untouched: the build plugin that copies `env.js` has no business running
 * during tests.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    // The app module boots on import, so every test mounts a fresh copy.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
