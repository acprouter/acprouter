#!/usr/bin/env node
import { existsSync } from "node:fs";

const builtCli = new URL("../dist/cli.js", import.meta.url);

if (!existsSync(builtCli)) {
  console.error(
    "@acprouter/acp: built CLI entry is missing.\n" +
      "If you are running from source, build it first:\n" +
      "  pnpm --filter @acprouter/acp build\n",
  );
  process.exit(1);
}

await import(builtCli.href);
