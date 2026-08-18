// A minimal, honest ACP AGENT speaking the Router's real consumer contract
// (task #14: `wss://.../api/acp?agentId=<id>` + `Authorization: Bearer
// <key>`) — the "real fixture Router endpoint" half of the shim's own
// subprocess integration test. Deliberately hand-rolled JSON-RPC over `ws`
// rather than importing the SDK, same house style as
// `apps/acprouter-cli/src/daemon/__fixtures__/fake-stdio-agent.mjs`: this
// fixture stands in for the real Next.js `/api/acp` route
// (`apps/acprouter/src/app/api/acp/route.ts`), and the point is proving the
// SHIM's own relay plumbing works against a real WebSocket server speaking
// real ACP, without needing the whole Router app (DB, Next.js, etc).
//
// Spawned as its own OS process, not hosted inline in the test runner —
// same hard-won finding `local-daemon.integration.test.ts` documents: a
// server hosted in the test process is unreachable from a child the test
// spawns in this sandboxed environment, while sibling processes reach each
// other fine over loopback. Prints `SERVER_READY <port>` once listening.
import { WebSocketServer } from "ws";

const EXPECTED_AGENT_ID = process.env.FAKE_ROUTER_AGENT_ID ?? "agent_fake_1";
const EXPECTED_API_KEY = process.env.FAKE_ROUTER_API_KEY ?? "ack_fake_test_key";

const wss = new WebSocketServer({ port: 0, path: "/api/acp" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const agentId = url.searchParams.get("agentId");
  const authHeader = req.headers.authorization;
  const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  // Mirrors the real Router's own posture (`consumer-acp-connection.ts`'s
  // doc comment): the upgrade always succeeds; a wrong credential/agentId
  // surfaces as a normal JSON-RPC error at `initialize`, never an opaque
  // pre-upgrade close.
  const authorized = agentId === EXPECTED_AGENT_ID && bearerKey === EXPECTED_API_KEY;

  function send(message) {
    socket.send(JSON.stringify(message));
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

  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString("utf8"));

    // A response to one of OUR outgoing requests (session/request_permission).
    if (message.method === undefined && message.id !== undefined) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
      return;
    }

    if (message.method === "initialize") {
      if (!authorized) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32001, message: "Unauthorized: bad agentId or credential" },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
        },
      });
      return;
    }

    if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess_fake_router_1" } });
      return;
    }

    if (message.method === "session/prompt") {
      const { sessionId } = message.params;
      const permissionOutcome = await requestClient("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc_fake_router_1",
          title: "run `echo hi`",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      notifyClient("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `permission:${permissionOutcome.result.outcome.outcome}` },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (message.method === "session/cancel") {
      // Notification, no response.
      return;
    }
  });
});

wss.on("listening", () => {
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`SERVER_READY ${port}`);
});
