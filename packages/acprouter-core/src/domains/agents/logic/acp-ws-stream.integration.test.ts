import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import type { WebSocketLike } from "@agentclientprotocol/sdk/experimental/ws-client";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { streamFromWebSocket } from "./acp-ws-stream";

const SESSION_ID = "sess_test_1" as acp.SessionId;

/**
 * Proves the transport shape spec §5.4 rests on: a socket the CLI *dials
 * out* can be handed to the SDK's *server* (agent) role, while the far end
 * (the Router, which accepted the connection) plays ACP *client* — and an
 * agent→client mid-turn request (`session/request_permission`) survives
 * that arrangement. This is the one thing every earlier rejected transport
 * design (relaylib's request/response shape, an invented requestId
 * correlation scheme) either couldn't do or had to bolt on.
 */
describe("streamFromWebSocket + AcpServer over a dialled-out socket", () => {
  it("carries a full initialize -> session/new -> session/prompt turn, including a mid-turn permission round trip", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const events: string[] = [];

    const routerDone = new Promise<acp.PromptResponse>((resolve, reject) => {
      wss.on("connection", (socket) => {
        const stream = streamFromWebSocket(socket);
        acp
          .client({ name: "router-test" })
          .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
            events.push(`permission-request:${ctx.params.toolCall.toolCallId}`);
            return {
              outcome: {
                outcome: "selected",
                optionId: ctx.params.options[0]?.optionId ?? "allow",
              },
            };
          })
          .onNotification(acp.methods.client.session.update, (ctx) => {
            events.push(`session-update:${ctx.params.update.sessionUpdate}`);
          })
          .connectWith(stream, async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
              cwd: process.cwd(),
              mcpServers: [],
            });
            return ctx.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "test prompt" }],
            });
          })
          .then(resolve, reject);
      });
    });

    const fakeAgent = acp
      .agent({ name: "cli-test-agent" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: SESSION_ID }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "tc_1",
            title: "rm -rf tmp/",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        events.push(`permission-outcome:${JSON.stringify(permission.outcome)}`);

        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        });

        return { stopReason: "end_turn" };
      });

    // The socket is a WS CLIENT dial (CLI -> Router), but it plays the ACP
    // AGENT role via AcpServer — direction of the handshake and ACP role are
    // independent (spec §5.4). `accept()` runs in the same tick as socket
    // construction, no `await` in between: this is the exact WS-upgrade
    // timing bug buda's own ACP server hit in PR #6155 (spec §5.4b) — a raw
    // `ws` frame receiver starts emitting the moment the socket opens, and a
    // frame that arrives before a listener is attached is DROPPED, not
    // queued. `initialize` is the first thing the Router sends, so a one-tick
    // gap here loses it and both sides hang forever.
    const acpServer = new AcpServer({ agent: fakeAgent });
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    acpServer.prepareWebSocketUpgrade().accept(cliSocket as unknown as WebSocketLike);

    const result = await routerDone;

    expect(result.stopReason).toBe("end_turn");
    expect(events).toEqual([
      "permission-request:tc_1",
      'permission-outcome:{"outcome":"selected","optionId":"allow"}',
      "session-update:agent_message_chunk",
    ]);

    cliSocket.close();
    wss.close();
    await acpServer.close();
  });
});
