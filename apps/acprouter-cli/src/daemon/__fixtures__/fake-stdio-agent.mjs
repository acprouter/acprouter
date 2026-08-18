// A minimal, honest ACP agent over stdio — the "real child process" half of
// `bridge-agent.integration.test.ts` (tier 2 in task #8's verification
// plan). Deliberately hand-rolled JSON-RPC rather than importing the SDK:
// this fixture stands in for a real `npx @agentclientprotocol/claude-agent-acp`
// process, and the point is proving `bridge-agent.ts`'s spawn + stdio-relay
// plumbing works against SOME real OS process speaking real newline-delimited
// JSON-RPC, without the cost/nondeterminism of a real LLM call (that's tier
// 3, done separately against the actual installed `claude` CLI).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    });
    return;
  }

  if (message.method === "session/new") {
    // Echoes back exactly what THIS process received in the request, so the
    // test can assert what `bridge-agent.ts` actually forwarded — not what
    // it claims to forward — for the two other Router-controlled,
    // filesystem-scope-expanding fields (invariant 2's extension, see
    // `bridge-agent.ts`'s doc comment on `mcpServers`/`additionalDirectories`).
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "sess_fake_stdio_1",
        _meta: {
          receivedCwd: message.params.cwd,
          receivedAdditionalDirectories: message.params.additionalDirectories,
          receivedMcpServers: message.params.mcpServers,
        },
      },
    });
    return;
  }

  if (message.method === "session/prompt") {
    const { sessionId } = message.params;
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
    notifyClient("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
});
