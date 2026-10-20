import { defineConfig } from "tsdown";

// No `noExternal` for `@acprouter/*` here, unlike `apps/acprouter-cli`'s
// tsdown config: this package has no workspace dependency on
// `@acprouter/core`/`@acprouter/contract` at all (spec §5.3 point 2 — the
// shim only ever needs the ACP SDK layer, not the Router's DB/oRPC control
// plane), so there is nothing workspace-local to bundle in.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  // package.json's bin script expects `dist/cli.js` — tsdown's default with
  // platform: "node" resolves to `.mjs` instead (established gotcha, PR #6548).
  outExtensions: () => ({ js: ".js" }),
});
