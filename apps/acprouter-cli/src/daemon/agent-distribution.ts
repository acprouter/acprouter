import { resolvePinnedDistribution } from "@acprouter/core/registry-sync";

export interface SpawnSpec {
  command: string;
  args: string[];
}

/**
 * Registry-only spawning (spec §8.2): the only input is a `registrySlug`
 * (e.g. `"claude-acp"`), never a command string — this function is the one
 * place that turns a slug into an actual `command`/`args` pair, by looking
 * it up in the CLI's own pinned registry copy and nowhere else. `npx` is the
 * MVP's only supported distribution kind; both bridged catalog entries
 * (`claude-acp`, `codex-acp`, per `detect.ts`) ship one. `-y` avoids `npx`
 * blocking on an interactive "ok to install" prompt, which would otherwise
 * hang a detached daemon process with no terminal to answer it.
 */
export function resolveAgentDistribution(registrySlug: string): SpawnSpec | null {
  const distribution = resolvePinnedDistribution(registrySlug);
  if (!distribution?.npx) return null;
  return {
    command: "npx",
    args: ["-y", distribution.npx.package, ...(distribution.npx.args ?? [])],
  };
}
