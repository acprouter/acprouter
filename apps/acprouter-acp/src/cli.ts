#!/usr/bin/env node
import { resolveShimConfig, ShimConfigError } from "./config";
import { createAcpShimApp } from "./shim";
import { streamFromProcessStdio } from "./stdio-stream";
import { resolveShimVersion } from "./version";
import { toConsumerAcpWebSocketUrl } from "./ws-url";

const HELP = `acprouter-acp — ACP Router consumer shim

Speaks ACP AGENT over its own stdio (what Zed/JetBrains spawn and talk to)
and ACP CLIENT over an outbound WebSocket to an ACP Router (what task #14
built at wss://<router>/api/acp?agentId=<id>).

Usage:
  acprouter-acp --agent <agentId> --server <router-url>

Options:
  --agent <agentId>   The Router-registered agent to connect to. Required.
  --server <url>       The Router's origin, e.g. https://router.example.com.
                        Required unless ACPROUTER_SERVER is set.
  --api-key <key>      Consumer API key. Local testing only — real Zed/
                        JetBrains config should set ACPROUTER_API_KEY in the
                        agent's \`env\`, never pass this as a flag (a flag is
                        visible to anything that can list this machine's
                        processes; an env var set via Zed's own \`env\` field
                        is not).
  --help, -h            Show this help.
  --version, -v         Print the installed version.

Environment:
  ACPROUTER_SERVER      Fallback for --server.
  ACPROUTER_API_KEY      The consumer API key. This is the path Zed/
                        JetBrains' \`Custom { command, args, env }\` config
                        should use.
`;

/**
 * Writes ALL diagnostics to stderr, never stdout — stdout is the ACP
 * transport (stdio-side `Stream`, per `stdio-stream.ts`), and anything else
 * written there would corrupt the newline-delimited JSON-RPC framing Zed is
 * reading.
 */
function log(line: string): void {
  console.error(`[acprouter-acp] ${line}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.error(resolveShimVersion());
    return;
  }

  let config: ReturnType<typeof resolveShimConfig>;
  try {
    config = resolveShimConfig(argv, process.env);
  } catch (error) {
    const message = error instanceof ShimConfigError ? error.message : String(error);
    console.error(`acprouter-acp: ${message}\n`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  const wsUrl = toConsumerAcpWebSocketUrl(config.server, config.agentId);
  log(`dialing ${wsUrl}`);

  const shim = createAcpShimApp({ wsUrl, apiKey: config.apiKey, log });
  const connection = shim.app.connect(streamFromProcessStdio());

  const shutdown = (signal: string) => {
    log(`received ${signal}, closing`);
    shim.close();
    connection.close(new Error(`acprouter-acp shim exiting on ${signal}`));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await connection.closed.catch((error) => {
    log(`stdio connection closed: ${error instanceof Error ? error.message : String(error)}`);
  });
  shim.close();
}

main().catch((error) => {
  console.error(
    `acprouter-acp: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
