import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads this package's own version from its `package.json`. `../package.json`
 * relative to this module resolves correctly in both dev (`src/version.ts` →
 * `apps/acprouter-cli/package.json`) and the tsup-bundled `dist/cli.js` (same
 * relative depth from `dist/`) — same reasoning as `RUN_BRIDGE_COMMAND`'s
 * self-respawn trick in `daemon/local-daemon.ts`.
 */
export function resolveCliVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
