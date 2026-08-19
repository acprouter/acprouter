import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "./tests/mocks/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // Default (10s) is tight for these: each integration test's beforeAll does
    // a real PGLite migration plus, in several files, standing up real WS
    // servers. Under any contention (this package's own suite alone takes
    // ~80s; running it alongside four sibling workspaces' test runs at once —
    // e.g. a plain `pnpm -r test` — regularly pushes individual hooks past
    // 10s) that manifests as a beforeAll timeout, which then cascades into a
    // *second*, misleading failure: afterAll's `wss.close()` throwing on
    // undefined because the hook that would have assigned `wss` never
    // finished. Matches apps/acprouter's own vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
