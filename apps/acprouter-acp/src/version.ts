import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads this package's own version from its `package.json` — same trick as
 * `apps/acprouter-cli/src/version.ts`: `../package.json` relative to this
 * module resolves correctly in both dev (`src/version.ts` →
 * `apps/acprouter-acp/package.json`) and the tsup-bundled `dist/cli.js`
 * (same relative depth from `dist/`).
 */
export function resolveShimVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
