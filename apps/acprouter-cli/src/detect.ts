import { spawnSync } from "node:child_process";

export interface DetectionResult {
  slug: string;
  installed: boolean;
  version: string | null;
  reason: string | null;
}

/**
 * The MVP's two bridged agents (spec §9 Phase 1) — mapped to the underlying
 * CLI the ACP adapter wraps. This is deliberately NOT a registry fetch: the
 * CLI stays a focused, fast-starting package (spec §6.1), and detection only
 * needs to know what binary to look for, not the adapter's pinned
 * `distribution` — resolving *that* against the CLI's own pinned registry
 * copy is task #8's job, enforcing the registry-only-spawning invariant
 * (spec §8.2), not this one's.
 */
const DETECTORS: Record<string, { binary: string; versionArgs: string[] }> = {
  "claude-acp": { binary: "claude", versionArgs: ["--version"] },
  "codex-acp": { binary: "codex", versionArgs: ["--version"] },
};

export const KNOWN_AGENT_SLUGS = Object.keys(DETECTORS);

/**
 * Detects whether the underlying tool for a bridged agent is installed on
 * this machine, and its version. Never throws — a missing binary, a PATH
 * miss, or a nonzero exit are all just different `reason` strings, per spec
 * §2b: "on failure, show a specific reason... never let the user fire a
 * request that is guaranteed to fail."
 */
export function detectAgent(slug: string): DetectionResult {
  const detector = DETECTORS[slug];
  if (!detector) {
    return {
      slug,
      installed: false,
      version: null,
      reason: `Detection not implemented for "${slug}".`,
    };
  }

  const result = spawnSync(detector.binary, detector.versionArgs, {
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? `"${detector.binary}" was not found on PATH. Install it, then run connect again.`
        : result.error.message;
    return { slug, installed: false, version: null, reason };
  }

  if (result.status !== 0) {
    return {
      slug,
      installed: false,
      version: null,
      reason: `"${detector.binary} ${detector.versionArgs.join(" ")}" exited with code ${result.status}.`,
    };
  }

  const version = (result.stdout || result.stderr || "").trim().split("\n")[0] || null;
  return { slug, installed: true, version, reason: null };
}

/** Detects every known bridged agent — the real `agents ls` (task #6). */
export function detectAllKnownAgents(): DetectionResult[] {
  return KNOWN_AGENT_SLUGS.map(detectAgent);
}
