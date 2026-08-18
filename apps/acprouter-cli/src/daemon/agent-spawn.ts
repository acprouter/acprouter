import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { resolveAgentDistribution, type SpawnSpec } from "./agent-distribution";
import { streamFromChildProcess } from "./subprocess-stream";

export interface SpawnAndInitializeOptions {
  /** The pinned-registry slug to resolve and spawn (spec §8.2 — registry-only spawning). */
  registrySlug: string;
  /** Working directory for the spawned agent — local-only, never Router-supplied (spec §5.6/§8.2). */
  dir: string;
  log?: (line: string) => void;
  /** Same override seam as `BridgeAgentDeps.resolveDistribution` — tests only, see there for why. */
  resolveDistribution?: (registrySlug: string) => SpawnSpec | null;
  /**
   * Relayed straight through to the built-in ACP client app's own handler
   * slots, unset by callers (like the auth prober) that have no session to
   * relay updates for yet.
   */
  onSessionUpdate?: acp.ClientNotificationHandler<acp.SessionNotification>;
  onRequestPermission?: acp.ClientRequestHandler<
    acp.RequestPermissionRequest,
    acp.RequestPermissionResponse
  >;
}

export interface SpawnedAgent {
  registrySlug: string;
  spawnSpec: SpawnSpec;
  child: ChildProcessWithoutNullStreams;
  inner: acp.ClientConnection;
  initializeResult: acp.InitializeResponse;
}

/**
 * The "spawn + connect as an ACP client + initialize" step shared by
 * `bridge-agent.ts`'s per-session spawn (task #8) and this task's
 * connect-time auth prober — both need exactly the same registry-only
 * resolution, stdio piping, stderr logging, and `initialize` handshake; only
 * what happens after (a real `session/new`, vs. an auth probe's own
 * `session/new` attempt) differs, so that part stays with each caller.
 *
 * On failure (unresolvable slug, spawn error, or a rejected/malformed
 * `initialize`), the process and connection this function itself created are
 * cleaned up before the error is re-thrown — callers never inherit a
 * half-open child process to clean up on this path.
 */
export async function spawnAndInitializeAgent(
  options: SpawnAndInitializeOptions,
): Promise<SpawnedAgent> {
  const log = options.log ?? (() => {});
  const resolveDistribution = options.resolveDistribution ?? resolveAgentDistribution;

  const spawnSpec = resolveDistribution(options.registrySlug);
  if (!spawnSpec) {
    throw acp.RequestError.invalidParams(
      { registrySlug: options.registrySlug },
      `"${options.registrySlug}" is not in this machine's pinned ACP registry, or has no npx distribution`,
    );
  }

  log(`spawning ${spawnSpec.command} ${spawnSpec.args.join(" ")} (cwd=${options.dir})`);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.dir,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  child.stderr.on("data", (chunk: Buffer) => {
    log(`[${options.registrySlug} stderr] ${chunk.toString("utf8").trimEnd()}`);
  });

  let clientApp = acp.client({ name: "acprouter-cli-bridge" });
  if (options.onSessionUpdate) {
    clientApp = clientApp.onNotification(
      acp.methods.client.session.update,
      options.onSessionUpdate,
    );
  }
  if (options.onRequestPermission) {
    clientApp = clientApp.onRequest(
      acp.methods.client.session.requestPermission,
      options.onRequestPermission,
    );
  }
  const inner = clientApp.connect(streamFromChildProcess(child));

  try {
    const initializeResult = await inner.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return { registrySlug: options.registrySlug, spawnSpec, child, inner, initializeResult };
  } catch (error) {
    child.kill();
    inner.close(error instanceof Error ? error : new Error(String(error)));
    if (error instanceof acp.RequestError) throw error;
    throw acp.RequestError.internalError(
      { registrySlug: options.registrySlug },
      `spawned agent failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Kills the spawned process and closes its connection — safe to call even if both are already gone. */
export async function closeSpawnedAgent(spawned: SpawnedAgent): Promise<void> {
  spawned.inner.close(new Error("done with this agent process"));
  if (spawned.child.exitCode === null && !spawned.child.killed) spawned.child.kill();
}
