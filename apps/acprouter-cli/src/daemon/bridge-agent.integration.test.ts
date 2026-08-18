import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeAgentApp } from "./bridge-agent";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/fake-stdio-agent.mjs", import.meta.url));
const FAKE_SLUG = "fake-stdio-agent";

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
});
