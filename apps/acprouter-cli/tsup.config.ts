import { defineConfig } from "tsup";

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
});
