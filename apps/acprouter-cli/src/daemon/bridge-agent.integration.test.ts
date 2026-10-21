import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeAgentHandle, createBridgeAgentApp } from "./bridge-agent";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/fake-stdio-agent.mjs", import.meta.url));
const FAKE_SLUG = "fake-stdio-agent";

function connectRouter(bridge: BridgeAgentHandle, events: string[] = []) {
  let router: acp.ClientConnection | undefined;
  const outer = bridge.app.connect(
    acp
      .client({ name: "router-recovery-test" })
      .onConnect((connection) => {
        router = connection;
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        events.push(`update:${ctx.params.sessionId}`);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        events.push(`permission:${ctx.params.sessionId}`);
        return {
          outcome: { outcome: "selected", optionId: ctx.params.options[0]?.optionId ?? "allow" },
        };
      }),
  );
  if (!router) throw new Error("Router did not connect");
  return { router, outer };
}

function readChildEvents(
  dir: string,
): { method: string; pid: number; params?: Record<string, unknown> }[] {
  const path = join(dir, ".fake-stdio-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function expectChildStopped(pid: number) {
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
}

const initialize: acp.InitializeRequest = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
};

/**
 * Tier 2 of task #8's verification plan: a REAL child process
 * (`fake-stdio-agent.mjs`, spawned for real, speaking real
 * newline-delimited JSON-RPC over real stdio pipes) standing in for
 * `npx @agentclientprotocol/claude-agent-acp` — proving the spawn +
 * inner-connection + relay plumbing in `bridge-agent.ts` actually works,
 * without the cost/nondeterminism of a real LLM call. The OUTER
 * Router-facing leg uses the SDK's in-process `AgentApp.connect(ClientApp)`
 * (no socket): that transport was already proven for real by task #7's
 * `acp-ws-stream.integration.test.ts` / `machine-bridge-connection.integration.test.ts`,
 * so re-proving it here would test something this file isn't about. What's
 * new here — spawning, stdio framing, and both relay directions — stays
 * fully real.
 */
describe("createBridgeAgentApp", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fakeResolveDistribution(slug: string) {
    if (slug !== FAKE_SLUG) return null;
    return { command: process.execPath, args: [FIXTURE_PATH] };
  }

  it("spawns a real subprocess on session/new and relays session/update + session/request_permission across both hops on session/prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-agent-test-"));
    const events: string[] = [];

    const bridge = createBridgeAgentApp({
      dir,
      log: (line) => events.push(`log:${line}`),
      resolveDistribution: fakeResolveDistribution,
    });

    let routerConnection: acp.ClientConnection | undefined;
    const routerClientApp = acp
      .client({ name: "router-test" })
      .onConnect((connection) => {
        routerConnection = connection;
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        events.push(`session-update:${ctx.params.update.sessionUpdate}`);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        events.push(`permission-request:${ctx.params.toolCall.toolCallId}`);
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: ctx.params.options[0]?.optionId ?? "allow",
          },
        };
      });

    const outerConnection = bridge.app.connect(routerClientApp);
    expect(routerConnection).toBeDefined();
    const router = routerConnection as acp.ClientConnection;

    try {
      await router.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      // Malformed slug (invariant 1 sanity check, not the adversarial suite
      // below): an unknown slug must fail closed with a clear error, never
      // fall through to spawning anything.
      await expect(
        router.agent.request(acp.methods.agent.session.new, {
          cwd: "/should-be-ignored",
          mcpServers: [],
          _meta: { registrySlug: "not-a-real-slug" },
        }),
      ).rejects.toThrow();

      const session = await router.agent.request(acp.methods.agent.session.new, {
        cwd: "/should-be-ignored",
        mcpServers: [],
        _meta: { registrySlug: FAKE_SLUG },
      });
      expect(session.sessionId).toBe("sess_fake_stdio_1");

      const promptResult = await router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "reply PONG" }],
      });

      expect(promptResult.stopReason).toBe("end_turn");
      expect(events).toEqual(
        expect.arrayContaining([
          "permission-request:tc_fake_1",
          "session-update:agent_message_chunk",
        ]),
      );

      await bridge.disposeAllSessions();
    } finally {
      outerConnection.close();
      router.close();
    }
  });

  it("adversarial: a Router that sends a hostile cwd/mcpServers/additionalDirectories still only ever spawns in the local dir with an empty mcpServers/additionalDirectories (spec §8.2)", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-agent-test-"));

    const bridge = createBridgeAgentApp({ dir, resolveDistribution: fakeResolveDistribution });
    let routerConnection: acp.ClientConnection | undefined;
    const routerClientApp = acp
      .client({ name: "router-test-adversarial" })
      .onConnect((connection) => {
        routerConnection = connection;
      });
    const outerConnection = bridge.app.connect(routerClientApp);
    const router = routerConnection as acp.ClientConnection;

    try {
      await router.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      // What the real Router-facing endpoint would receive from a hostile or
      // compromised caller: a `cwd` outside this machine, extra roots
      // reaching outside it, and an `mcpServers` entry that is itself a
      // `{command, args}` spawn primitive (`touch` chosen only because its
      // side effect — a file appearing — would be unambiguous proof it ran;
      // the point of this test is that it must NEVER get the chance to).
      const hostileRequest: acp.NewSessionRequest = {
        cwd: "/definitely/does/not/exist/on/this/machine",
        additionalDirectories: ["/etc"],
        mcpServers: [
          {
            name: "hostile",
            command: "touch",
            args: ["/tmp/acprouter-e2e-should-never-be-created"],
            env: [],
          },
        ],
        _meta: { registrySlug: FAKE_SLUG },
      };
      const session = await router.agent.request(acp.methods.agent.session.new, hostileRequest);

      const newSessionMeta = session._meta as {
        receivedCwd: string;
        receivedAdditionalDirectories: string[];
        receivedMcpServers: unknown[];
      };
      // These are what the SPAWNED PROCESS actually received — proof
      // `bridge-agent.ts` never forwarded the Router's hostile values, not
      // just that it claims not to.
      expect(newSessionMeta.receivedCwd).toBe(dir);
      expect(newSessionMeta.receivedAdditionalDirectories).toEqual([]);
      expect(newSessionMeta.receivedMcpServers).toEqual([]);

      await bridge.disposeAllSessions();
    } finally {
      outerConnection.close();
      router.close();
    }
  });

  it("task #10: initialize's response _meta reports registrySlug/cwd/authStatus as configured, with a real (if 'not installed') detection result", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-agent-test-"));

    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      authStatus: { state: "sign_in_needed", detail: "run `fake-stdio-agent login`" },
      resolveDistribution: fakeResolveDistribution,
    });

    let routerConnection: acp.ClientConnection | undefined;
    const routerClientApp = acp.client({ name: "router-test-meta" }).onConnect((connection) => {
      routerConnection = connection;
    });
    const outerConnection = bridge.app.connect(routerClientApp);
    const router = routerConnection as acp.ClientConnection;

    try {
      const initializeResult = await router.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      // `FAKE_SLUG` isn't one of the CLI's real detectors (`claude-acp`/
      // `codex-acp`) — `detectAgent` honestly reports "not implemented"
      // rather than the bridge fabricating a version, proving this really
      // called the shared `detectAgent` rather than echoing something
      // hand-wired for the test.
      expect(initializeResult._meta).toEqual({
        registrySlug: FAKE_SLUG,
        cwd: dir,
        detectedVersion: null,
        authState: "sign_in_needed",
        authDetail: "run `fake-stdio-agent login`",
      });
    } finally {
      outerConnection.close();
      router.close();
    }
  });

  it("forwards the SPAWNED agent's promptCapabilities on session/new, which initialize cannot carry", async () => {
    // The Router has no other way to learn them. This bridge does not spawn
    // anything until `session/new`, so its own `initialize` answers for the
    // CLI, not for the agent — asserted here as well, so a future change that
    // "helpfully" reports the agent's capabilities on the handshake instead
    // is caught rather than silently changing which one the Router trusts.
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-agent-test-"));
    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
    });

    let routerConnection: acp.ClientConnection | undefined;
    const routerClientApp = acp
      .client({ name: "router-test-prompt-caps" })
      .onConnect((connection) => {
        routerConnection = connection;
      });
    const outerConnection = bridge.app.connect(routerClientApp);
    const router = routerConnection as acp.ClientConnection;

    try {
      const initializeResult = await router.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initializeResult.agentCapabilities?.promptCapabilities).toBeUndefined();

      const session = await router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
        _meta: { registrySlug: FAKE_SLUG },
      });

      // Exactly what the real child process advertised — `audio` absent, not
      // defaulted to false, so the Router can tell "not supported" from
      // "never mentioned".
      expect((session._meta as { promptCapabilities?: unknown }).promptCapabilities).toEqual({
        image: true,
        embeddedContext: true,
      });
    } finally {
      outerConnection.close();
      router.close();
    }
  });

  it("task #10: a bridge with no configured registrySlug/authStatus (the pre-task-10 shape) reports an all-null _meta, not a crash", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-agent-test-"));

    const bridge = createBridgeAgentApp({ dir, resolveDistribution: fakeResolveDistribution });

    let routerConnection: acp.ClientConnection | undefined;
    const routerClientApp = acp
      .client({ name: "router-test-meta-empty" })
      .onConnect((connection) => {
        routerConnection = connection;
      });
    const outerConnection = bridge.app.connect(routerClientApp);
    const router = routerConnection as acp.ClientConnection;

    try {
      const initializeResult = await router.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      expect(initializeResult._meta).toEqual({
        registrySlug: null,
        cwd: dir,
        detectedVersion: null,
        authState: null,
        authDetail: null,
      });
    } finally {
      outerConnection.close();
      router.close();
    }
  });

  it("reuses a live child across outer connections, preserving metadata and both relay directions without replaying a prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-reconnect-test-"));
    const logs: string[] = [];
    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
      log: (line) => logs.push(line),
    });
    const firstEvents: string[] = [];
    const first = connectRouter(bridge, firstEvents);
    let second: ReturnType<typeof connectRouter> | undefined;
    try {
      expect(
        (await first.router.agent.request(acp.methods.agent.initialize, initialize))
          .agentCapabilities?.loadSession,
      ).toBe(true);
      const session = await first.router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
      });
      const firstResult = await first.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "reply PONG" }],
      });
      expect(firstResult.stopReason).toBe("end_turn");
      expect(firstEvents).toEqual([
        `permission:${session.sessionId}`,
        `update:${session.sessionId}`,
      ]);

      first.outer.close();
      await first.outer.closed;
      const secondEvents: string[] = [];
      second = connectRouter(bridge, secondEvents);
      await second.router.agent.request(acp.methods.agent.initialize, initialize);
      const loaded = await second.router.agent.request(acp.methods.agent.session.load, {
        sessionId: session.sessionId,
        cwd: "/ignored",
        mcpServers: [],
      });
      const { sessionId: _, ...originalMetadata } = session;
      expect(loaded).toEqual(originalMetadata);
      await second.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "second turn" }],
      });
      expect(secondEvents).toEqual([
        `permission:${session.sessionId}`,
        `update:${session.sessionId}`,
      ]);
      expect(firstEvents).toHaveLength(2);
      const childEvents = readChildEvents(dir);
      expect(childEvents.filter((event) => event.method === "spawn")).toHaveLength(1);
      expect(childEvents.filter((event) => event.method === "session/new")).toHaveLength(1);
      expect(childEvents.filter((event) => event.method === "session/load")).toHaveLength(0);
      expect(childEvents.filter((event) => event.method === "session/prompt")).toHaveLength(2);
      expect(logs.some((line) => line.includes("failed to relay"))).toBe(false);
    } finally {
      await bridge.disposeAllSessions();
      first.outer.close();
      first.router.close();
      second?.outer.close();
      second?.router.close();
    }
  });

  it("routes an already dispatched turn to the replacement connection without resending it", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-inflight-test-"));
    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
    });
    const first = connectRouter(bridge);
    let second: ReturnType<typeof connectRouter> | undefined;
    try {
      await first.router.agent.request(acp.methods.agent.initialize, initialize);
      const session = await first.router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
      });
      const pending = first.router.agent
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "wait-for-reconnect" }],
        })
        .catch(() => undefined);
      await expect
        .poll(
          () => readChildEvents(dir).filter((event) => event.method === "session/prompt").length,
        )
        .toBe(1);
      first.outer.close();
      await first.outer.closed;
      const events: string[] = [];
      second = connectRouter(bridge, events);
      await second.router.agent.request(acp.methods.agent.initialize, initialize);
      await expect(
        second.router.agent.request(acp.methods.agent.session.load, {
          sessionId: session.sessionId,
          cwd: dir,
          mcpServers: [],
        }),
      ).rejects.toThrow("active prompt");
      await expect(
        second.router.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "must not dispatch" }],
        }),
      ).rejects.toThrow("active prompt");
      writeFileSync(join(dir, ".fake-stdio-release"), "release original turn");
      await expect
        .poll(() => events)
        .toEqual([`permission:${session.sessionId}`, `update:${session.sessionId}`]);
      // Only the inner response releases the guard, so loading works again
      // after the original turn settles without sending a second prompt.
      await expect
        .poll(async () => {
          try {
            await second?.router.agent.request(acp.methods.agent.session.load, {
              sessionId: session.sessionId,
              cwd: dir,
              mcpServers: [],
            });
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      expect(
        readChildEvents(dir).filter((event) => event.method === "session/prompt"),
      ).toHaveLength(1);
      await pending;
    } finally {
      await bridge.disposeAllSessions();
      first.outer.close();
      first.router.close();
      second?.outer.close();
      second?.router.close();
    }
  });

  it("restores persisted state once after bridge restart and sanitizes all Router filesystem and MCP inputs", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-restore-test-"));
    const originalBridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
    });
    const original = connectRouter(originalBridge);
    const bridge = createBridgeAgentApp({
      dir,
      resolveDistribution: fakeResolveDistribution,
    });
    const events: string[] = [];
    const restored = connectRouter(bridge, events);
    try {
      await original.router.agent.request(acp.methods.agent.initialize, initialize);
      const session = await original.router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
      });
      await original.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "first turn" }],
      });
      await originalBridge.disposeAllSessions();
      await expectChildStopped(session._meta?.childPid as number);
      await restored.router.agent.request(acp.methods.agent.initialize, initialize);
      const hostileLoad: acp.LoadSessionRequest = {
        sessionId: session.sessionId,
        cwd: "/hostile",
        additionalDirectories: ["/etc"],
        mcpServers: [
          {
            name: "hostile",
            command: "touch",
            args: ["/tmp/acprouter-should-never-create"],
            env: [],
          },
        ],
        _meta: { registrySlug: FAKE_SLUG },
      };
      const [loaded, concurrent] = await Promise.all([
        restored.router.agent.request(acp.methods.agent.session.load, hostileLoad),
        restored.router.agent.request(acp.methods.agent.session.load, hostileLoad),
      ]);
      expect(concurrent).toEqual(loaded);
      expect(loaded._meta).toMatchObject({
        receivedCwd: dir,
        receivedMcpServers: [],
        receivedAdditionalDirectories: [],
        promptCapabilities: { image: true, embeddedContext: true },
      });
      await restored.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "second turn" }],
      });
      expect(events).toEqual([`permission:${session.sessionId}`, `update:${session.sessionId}`]);
      expect(JSON.parse(readFileSync(join(dir, ".fake-stdio-session.json"), "utf8")).turns).toBe(2);
      const childEvents = readChildEvents(dir);
      expect(childEvents.filter((event) => event.method === "spawn")).toHaveLength(2);
      expect(childEvents.filter((event) => event.method === "session/new")).toHaveLength(1);
      expect(childEvents.filter((event) => event.method === "session/load")).toHaveLength(1);
    } finally {
      await originalBridge.disposeAllSessions();
      await bridge.disposeAllSessions();
      original.outer.close();
      original.router.close();
      restored.outer.close();
      restored.router.close();
    }
  });

  it("drops disconnected updates once, refuses disconnected permissions, and never replays either after reconnect", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-disconnected-test-"));
    const logs: string[] = [];
    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
      log: (line) => logs.push(line),
    });
    const first = connectRouter(bridge);
    let second: ReturnType<typeof connectRouter> | undefined;
    try {
      await first.router.agent.request(acp.methods.agent.initialize, initialize);
      const session = await first.router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
      });
      const pending = first.router.agent
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "wait-while-disconnected" }],
        })
        .catch(() => undefined);
      await expect
        .poll(
          () => readChildEvents(dir).filter((event) => event.method === "session/prompt").length,
        )
        .toBe(1);
      first.outer.close();
      await first.outer.closed;
      await expect
        .poll(() => logs.filter((line) => line.includes("dropping session updates")).length)
        .toBe(1);
      await expect
        .poll(() => readChildEvents(dir).some((event) => event.method === "offline-turn-complete"))
        .toBe(true);
      const events: string[] = [];
      second = connectRouter(bridge, events);
      await second.router.agent.request(acp.methods.agent.initialize, initialize);
      await expect
        .poll(async () => {
          try {
            await second?.router.agent.request(acp.methods.agent.session.load, {
              sessionId: session.sessionId,
              cwd: dir,
              mcpServers: [],
            });
            return true;
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("active prompt")) throw error;
            return false;
          }
        })
        .toBe(true);
      await second.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "next turn" }],
      });
      expect(events).toEqual([`permission:${session.sessionId}`, `update:${session.sessionId}`]);
      expect(
        readChildEvents(dir).filter((event) => event.method === "session/prompt"),
      ).toHaveLength(2);
      expect(logs.filter((line) => line.includes("dropping session updates"))).toHaveLength(1);
      await pending;
    } finally {
      await bridge.disposeAllSessions();
      first.outer.close();
      first.router.close();
      second?.outer.close();
      second?.router.close();
    }
  });

  it.each([false, true])(
    "fails closed and kills the child for unknown/unsupported load (unsupported=%s), without session/new",
    async (unsupported) => {
      dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-load-failure-test-"));
      const bridge = createBridgeAgentApp({
        dir,
        registrySlug: FAKE_SLUG,
        resolveDistribution: (slug) =>
          slug === FAKE_SLUG
            ? {
                command: process.execPath,
                args: [FIXTURE_PATH, ...(unsupported ? ["--no-load"] : [])],
              }
            : null,
      });
      const connection = connectRouter(bridge);
      try {
        await connection.router.agent.request(acp.methods.agent.initialize, initialize);
        await expect(
          connection.router.agent.request(acp.methods.agent.session.load, {
            sessionId: "missing",
            cwd: dir,
            mcpServers: [],
          }),
        ).rejects.toThrow(unsupported ? "does not support" : "unknown session");
        const childEvents = readChildEvents(dir);
        expect(childEvents.filter((event) => event.method === "spawn")).toHaveLength(1);
        expect(childEvents.some((event) => event.method === "session/new")).toBe(false);
        expect(childEvents.some((event) => event.method === "session/load")).toBe(!unsupported);
        await expectChildStopped(childEvents[0]?.pid as number);
      } finally {
        await bridge.disposeAllSessions();
        connection.outer.close();
        connection.router.close();
      }
    },
  );

  it("rejects missing, malformed, unpinned and mismatched recovery slugs without spawning", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-load-slug-test-"));
    const bridge = createBridgeAgentApp({ dir, resolveDistribution: fakeResolveDistribution });
    const configuredBridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
    });
    const connection = connectRouter(bridge);
    const configured = connectRouter(configuredBridge);
    try {
      await connection.router.agent.request(acp.methods.agent.initialize, initialize);
      await configured.router.agent.request(acp.methods.agent.initialize, initialize);
      for (const _meta of [undefined, { registrySlug: 42 }, { registrySlug: "not-pinned" }]) {
        await expect(
          connection.router.agent.request(acp.methods.agent.session.load, {
            sessionId: "missing",
            cwd: dir,
            mcpServers: [],
            _meta,
          }),
        ).rejects.toThrow();
      }
      await expect(
        configured.router.agent.request(acp.methods.agent.session.load, {
          sessionId: "missing",
          cwd: dir,
          mcpServers: [],
          _meta: { registrySlug: "other-agent" },
        }),
      ).rejects.toThrow("does not match");
      expect(readChildEvents(dir)).toEqual([]);
    } finally {
      await bridge.disposeAllSessions();
      await configuredBridge.disposeAllSessions();
      connection.outer.close();
      connection.router.close();
      configured.outer.close();
      configured.router.close();
    }
  });

  it("returns the child's latest mode and configuration when reattaching a live session", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-bridge-config-test-"));
    const bridge = createBridgeAgentApp({
      dir,
      registrySlug: FAKE_SLUG,
      resolveDistribution: fakeResolveDistribution,
    });
    const connection = connectRouter(bridge);
    try {
      await connection.router.agent.request(acp.methods.agent.initialize, initialize);
      const session = await connection.router.agent.request(acp.methods.agent.session.new, {
        cwd: dir,
        mcpServers: [],
      });
      await connection.router.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "update-config" }],
      });
      const loaded = await connection.router.agent.request(acp.methods.agent.session.load, {
        sessionId: session.sessionId,
        cwd: dir,
        mcpServers: [],
      });
      expect(loaded.modes?.currentModeId).toBe("updated-mode");
      expect(loaded.configOptions).toEqual([
        { id: "confirm", name: "Confirm", type: "boolean", currentValue: true },
      ]);
    } finally {
      await bridge.disposeAllSessions();
      connection.outer.close();
      connection.router.close();
    }
  });
});
