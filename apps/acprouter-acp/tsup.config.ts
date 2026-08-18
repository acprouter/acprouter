import { defineConfig } from "tsup";

// No `noExternal` for `@acprouter/*` here, unlike `apps/acprouter-cli`'s
// tsup config: this package has no workspace dependency on
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
});
