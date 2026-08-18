import type { ChildProcessByStdio, ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves this task's actual deliverable for real: the BUILT `@acprouter/acp`
 * shim, spawned as a real OS child process exactly the way Zed's
 * `Custom { command, args, env }` would invoke it
 * (`node bin/acprouter-acp.mjs --agent ... --server ...`), driven over its
 * own real stdio by a raw ACP client (standing in for Zed), relaying a real
 * ACP session — including a `session/request_permission` round trip — to a
 * fixture Router endpoint speaking the real `/api/acp?agentId=` contract
 * task #14 built.
 *
 * Both the fixture Router and the shim are spawned as SEPARATE OS processes,
 * siblings of this test process — not a server hosted inline here. That is
 * a hard requirement in this sandboxed environment, not a style choice: see
 * `apps/acprouter-cli/src/daemon/local-daemon.integration.test.ts`'s own
 * documented finding that a server living in the test runner's process is
 * unreachable from a child process the test spawns, while sibling processes
 * reach each other fine over loopback.
 */
describe("@acprouter/acp shim — real built binary, real subprocess, real relay", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const binEntry = fileURLToPath(new URL("../bin/acprouter-acp.mjs", import.meta.url));
  const fixtureScript = fileURLToPath(
    new URL("./__fixtures__/fake-router-acp-server.mjs", import.meta.url),
  );

  const AGENT_ID = "agent_fake_1";
  const API_KEY = "ack_fake_test_key";

  const spawnedProcesses: { exitCode: number | null; killed: boolean; kill: () => boolean }[] = [];

  beforeAll(() => {
    const build = spawnSync("pnpm", ["run", "build"], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (build.status !== 0) {
      throw new Error(
        `pnpm run build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
      );
    }
  }, 70_000);

  afterEach(() => {
    for (const proc of spawnedProcesses.splice(0)) {
      if (proc.exitCode === null && !proc.killed) proc.kill();
    }
  });

  function startFakeRouter(): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve, reject) => {
      const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
        process.execPath,
        [fixtureScript],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FAKE_ROUTER_AGENT_ID: AGENT_ID, FAKE_ROUTER_API_KEY: API_KEY },
        },
      );
      spawnedProcesses.push(proc);

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("fake router did not report ready in time"));
      }, 5000);

      proc.stdout.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/SERVER_READY (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve({ url: `http://127.0.0.1:${match[1]}`, close: () => proc.kill() });
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        console.error(`[fake-router stderr] ${chunk.toString()}`);
      });
    });
  }

  function spawnShim(args: string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
    const proc = spawn(process.execPath, [binEntry, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }) as ChildProcessWithoutNullStreams;
    spawnedProcesses.push(proc);
    proc.stderr.on("data", (chunk: Buffer) => {
      console.error(`[shim stderr] ${chunk.toString()}`);
    });
    return proc;
  }

  /** Wraps the shim CHILD's stdio into an ACP `Stream` — the raw-test-client mirror of `apps/acprouter-cli/src/daemon/subprocess-stream.ts`, standing in for what Zed does to its own spawned agent process. */
  function streamFromShimChild(child: ChildProcessWithoutNullStreams): acp.Stream {
    return acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
  }

  afterAll(() => {
    for (const proc of spawnedProcesses) {
      if (proc.exitCode === null && !proc.killed) proc.kill();
    }
  });

  it("relays initialize -> session/new -> session/prompt end to end, including a real permission round trip, credential via ACPROUTER_API_KEY env (the path Zed's config should use)", async () => {
    const router = await startFakeRouter();
    const shimChild = spawnShim(["--agent", AGENT_ID, "--server", router.url], {
      ACPROUTER_API_KEY: API_KEY,
    });

    const stream = streamFromShimChild(shimChild);
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const receivedUpdates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: "raw-test-client" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        receivedUpdates.push(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(ctx.params);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      })
      .connect(stream);

    const init = await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(init.agentCapabilities?.loadSession).toBe(false);

    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    expect(sessionId).toBe("sess_fake_router_1");

    const result = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(result.stopReason).toBe("end_turn");
    // The permission round trip really happened, through the shim, both
    // ways: the fixture Router asked, this raw client's own handler
    // answered "allow", and the fixture Router's resulting session/update
    // (echoing what it received) arrived back here relayed through the
    // shim — proving both the outbound request leg and the inbound
    // notification leg are real, not just "the client's own request
    // resolved locally."
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.toolCall.toolCallId).toBe("tc_fake_router_1");
    expect(receivedUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "permission:selected" },
        },
      },
    ]);

    client.close();
    shimChild.kill();
    router.close();
  }, 20_000);

  it("rejects at initialize with a clear error on a wrong credential, never hangs", async () => {
    const router = await startFakeRouter();
    const shimChild = spawnShim(["--agent", AGENT_ID, "--server", router.url], {
      ACPROUTER_API_KEY: "ack_totally_wrong",
    });

    const stream = streamFromShimChild(shimChild);
    const client = acp.client({ name: "raw-test-client" }).connect(stream);

    await expect(
      client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).rejects.toBeTruthy();

    client.close();
    shimChild.kill();
    router.close();
  }, 20_000);

  it("fails initialize with a clear, bounded error (not a hang) when the Router is unreachable", async () => {
    // Port 1 is a real closed/unreachable target on loopback (privileged,
    // nothing ever listens there) — a real, immediate connection-refused
    // condition, not a mock.
    const shimChild = spawnShim(
      ["--agent", AGENT_ID, "--server", "http://127.0.0.1:1", "--api-key", API_KEY],
      {},
    );
    const stream = streamFromShimChild(shimChild);
    const client = acp.client({ name: "raw-test-client" }).connect(stream);

    const start = Date.now();
    await expect(
      client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).rejects.toBeTruthy();
    expect(Date.now() - start).toBeLessThan(16_000);

    client.close();
    shimChild.kill();
  }, 20_000);
});
