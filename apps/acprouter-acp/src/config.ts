/**
 * This shim's whole CLI surface (spec §5.3 point 2): `--agent <id>`,
 * `--server <router-url>` (or `ACPROUTER_SERVER`), and a bearer credential.
 * Deliberately plain `process.argv` parsing, not `commander` —
 * `apps/acprouter-cli` earns a dependency on it by having six subcommands
 * with their own `--help`; this package has exactly one thing to do (run),
 * so a dependency would buy nothing a flat switch doesn't already give.
 */
export interface ParsedShimArgv {
  help: boolean;
  version: boolean;
  agent?: string;
  server?: string;
  apiKey?: string;
}

export function parseShimArgv(argv: readonly string[]): ParsedShimArgv {
  const result: ParsedShimArgv = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--version":
      case "-v":
        result.version = true;
        break;
      case "--agent":
        result.agent = argv[++i];
        break;
      case "--server":
        result.server = argv[++i];
        break;
      case "--api-key":
        result.apiKey = argv[++i];
        break;
      default:
        // Unknown flags are ignored rather than fatal: Zed/JetBrains own the
        // config UI that produces `args`, and a future version adding a new
        // flag should not break an older shim mid-rollout.
        break;
    }
  }
  return result;
}

export interface ShimConfig {
  server: string;
  agentId: string;
  apiKey: string;
}

export class ShimConfigError extends Error {}

/**
 * Resolves the shim's config from argv + env, or throws `ShimConfigError`
 * with a message written for a human reading their terminal (or Zed's own
 * "agent failed to start" surface), never a stack trace.
 *
 * The credential's primary path is `ACPROUTER_API_KEY`, not `--api-key`
 * (spec §5.3 point 2 / this task's own steer): Zed and JetBrains' actual
 * config schema for a custom agent is `Custom { command, args, env }` — an
 * `env` field is exactly where a secret belongs. A value in `args` shows up
 * verbatim to anything that can list this machine's processes (`ps aux`,
 * `/proc/<pid>/cmdline`); a value in `env` does not show up the same way.
 * `--api-key` is kept only as a convenience/testing override for a human
 * running this by hand at a terminal — production Zed/JetBrains config
 * should always set `ACPROUTER_API_KEY` in `env`, never pass `--api-key`.
 */
export function resolveShimConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ShimConfig {
  const parsed = parseShimArgv(argv);

  const agentId = parsed.agent;
  if (!agentId) {
    throw new ShimConfigError("--agent <agentId> is required.");
  }

  const server = parsed.server ?? env.ACPROUTER_SERVER;
  if (!server) {
    throw new ShimConfigError("--server <router-url> is required (or set ACPROUTER_SERVER).");
  }

  const apiKey = parsed.apiKey ?? env.ACPROUTER_API_KEY;
  if (!apiKey) {
    throw new ShimConfigError(
      "an API key is required: set ACPROUTER_API_KEY in the environment (this is what Zed/" +
        "JetBrains' `env` config field should carry) or pass --api-key for local testing.",
    );
  }

  return { server, agentId, apiKey };
}
