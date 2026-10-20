// A minimal, honest ACP agent over stdio — the "real child process" half of
// `bridge-agent.integration.test.ts` (tier 2 in task #8's verification
// plan). Deliberately hand-rolled JSON-RPC rather than importing the SDK:
// this fixture stands in for a real `npx @agentclientprotocol/claude-agent-acp`
// process, and the point is proving `bridge-agent.ts`'s spawn + stdio-relay
// plumbing works against SOME real OS process speaking real newline-delimited
// JSON-RPC, without the cost/nondeterminism of a real LLM call (that's tier
// 3, done separately against the actual installed `claude` CLI).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });
const statePath = join(process.cwd(), ".fake-stdio-session.json");
const eventsPath = join(process.cwd(), ".fake-stdio-events.jsonl");
const sessionId = "sess_fake_stdio_1";
let turns = 0;
function record(method, params) {
  appendFileSync(eventsPath, `${JSON.stringify({ method, params, pid: process.pid })}\n`);
}
record("spawn");

function sessionResponse(params) {
  return {
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    configOptions: [],
    _meta: {
      receivedCwd: params.cwd,
      receivedAdditionalDirectories: params.additionalDirectories,
      receivedMcpServers: params.mcpServers,
      childPid: process.pid,
    },
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextRequestId = 9000;
const pending = new Map();

function requestClient(method, params) {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notifyClient(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  const message = JSON.parse(text);

  // A response to one of OUR outgoing requests (e.g. session/request_permission) —
  // JSON-RPC responses carry no `method`, only `id` plus `result`/`error`.
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
    return;
  }

  if (message.method === "initialize") {
    record(message.method, message.params);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        // `promptCapabilities` is deliberately partial — `audio` omitted —
        // so the bridge test can prove the SPAWNED agent's real answer is
        // what reaches the Router, rather than something invented or
        // defaulted along the way.
        agentCapabilities: {
          loadSession: !process.argv.includes("--no-load"),
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    record(message.method, message.params);
    turns = 0;
    writeFileSync(statePath, JSON.stringify({ sessionId, turns }));
    // Echoes back exactly what THIS process received in the request, so the
    // test can assert what `bridge-agent.ts` actually forwarded — not what
    // it claims to forward — for the two other Router-controlled,
    // filesystem-scope-expanding fields (invariant 2's extension, see
    // `bridge-agent.ts`'s doc comment on `mcpServers`/`additionalDirectories`).
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId,
        ...sessionResponse(message.params),
      },
    });
    return;
  }

  if (message.method === "session/load") {
    record(message.method, message.params);
    if (!existsSync(statePath) || message.params.sessionId !== sessionId) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown session" } });
      return;
    }
    turns = JSON.parse(readFileSync(statePath, "utf8")).turns;
    send({ jsonrpc: "2.0", id: message.id, result: sessionResponse(message.params) });
    return;
  }

  if (message.method === "session/prompt") {
    record(message.method, message.params);
    const { sessionId } = message.params;
    turns += 1;
    writeFileSync(statePath, JSON.stringify({ sessionId, turns }));
    if (message.params.prompt.some((content) => content.text === "wait-for-reconnect")) {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!existsSync(join(process.cwd(), ".fake-stdio-release"))) return;
          clearInterval(timer);
          resolve();
        }, 10);
      });
    }
    if (message.params.prompt.some((content) => content.text === "wait-while-disconnected")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // Mid-turn permission round trip — the exact shape task #8 has to prove
    // survives two hops (this process -> bridge-agent's inner connection ->
    // the outer Router-facing connection), mirroring
    // `acp-ws-stream.integration.test.ts`'s fakeAgent.
    await requestClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc_fake_1", title: "reply", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (message.params.prompt.some((content) => content.text === "update-config")) {
      notifyClient("session/update", {
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: "updated-mode" },
      });
      notifyClient("session/update", {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "confirm", name: "Confirm", type: "boolean", currentValue: true }],
        },
      });
    }
    const chunks = message.params.prompt.some(
      (content) => content.text === "wait-while-disconnected",
    )
      ? 3
      : 1;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      notifyClient("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
      });
    }
    if (chunks === 3) {
      // This round trip follows every offline notification on the same
      // stdio stream. Its rejection proves the bridge consumed all chunks
      // before the test reconnects the Router.
      await requestClient("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc_offline_barrier",
          title: "offline barrier",
          kind: "execute",
          status: "pending",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      record("offline-turn-complete");
    }
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
});
