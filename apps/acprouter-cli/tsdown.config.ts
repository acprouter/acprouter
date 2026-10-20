import { defineConfig } from "tsdown";

// `@acprouter/contract` and `@acprouter/core` ship TypeScript source (workspace
// packages, not published runtime deps a consumer would have installed), so
// they cannot be external for the published npm CLI — bundle them straight
// into dist instead.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  noExternal: [/^@acprouter\//],
  // package.json's bin script expects `dist/cli.js` — tsdown's default with
  // platform: "node" resolves to `.mjs` instead (established gotcha, PR #6548).
  outExtensions: () => ({ js: ".js" }),
});
