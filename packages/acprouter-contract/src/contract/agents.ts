import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { AgentVOSchema, ConnectRemoteAcpAgentInputSchema } from "../types/agent";
import {
  AgentSessionStreamEventVOSchema,
  AnswerAgentSessionPermissionInputSchema,
  AnswerAgentSessionPermissionOutputSchema,
  EndAgentSessionInputSchema,
  GetAgentSessionHistoryInputSchema,
  PromptAgentSessionInputSchema,
  StartAgentSessionInputSchema,
  StartAgentSessionOutputSchema,
} from "../types/agent-session";
import {
  ConsumerApiKeyVOSchema,
  ListConsumerApiKeysInputSchema,
  MintConsumerApiKeyInputSchema,
  MintConsumerApiKeyOutputSchema,
  RevokeConsumerApiKeyInputSchema,
  RevokeConsumerApiKeyOutputSchema,
} from "../types/consumer-api-key";
import {
  MachineVOSchema,
  MintEnrollmentTokenInputSchema,
  MintEnrollmentTokenOutputSchema,
} from "../types/machine";

export const agentsContract = oc.router({
  machines: oc.router({
    list: oc.output(z.array(MachineVOSchema)),
    mint: oc.input(MintEnrollmentTokenInputSchema).output(MintEnrollmentTokenOutputSchema),
  }),
  // Real registered rows (task #10) — distinct from the static catalog
  // (`getAgentCatalog`, not an oRPC procedure at all): this is "what's
  // actually connected right now", the dashboard's `agents.agents.list`.
  agents: oc.router({
    list: oc.output(z.array(AgentVOSchema)),
    /**
     * Task #13's Buda Add flow (spec §2b Story B): validates the endpoint +
     * API key with a real ACP dial before persisting anything — see
     * `remote-agents-logic.ts#connectRemoteAcpAgent`. Returns the same
     * `AgentVOSchema` as `list` (not a distinct "connect result" shape) so
     * the dialog's success handler needs no translation before handing the
     * new row to the same card renderer `list` already feeds.
     */
    connectRemoteAcp: oc.input(ConnectRemoteAcpAgentInputSchema).output(AgentVOSchema),
  }),
  /**
   * Task #14 — the credential external ACP consumers (spec §5.3 point 1)
   * present at `wss://<router>/api/acp?agentId=<id>`. One owner (spec §8.1:
   * no accounts), so there is nothing to scope a "list" by except the agent
   * itself — no separate `/consumer-keys` router, this lives under `agents`
   * because every key belongs to exactly one agent (module doc comment on
   * `consumer-api-keys.ts` explains why per-agent, not Router-wide).
   */
  consumerKeys: oc.router({
    list: oc.input(ListConsumerApiKeysInputSchema).output(z.array(ConsumerApiKeyVOSchema)),
    mint: oc.input(MintConsumerApiKeyInputSchema).output(MintConsumerApiKeyOutputSchema),
    revoke: oc.input(RevokeConsumerApiKeyInputSchema).output(RevokeConsumerApiKeyOutputSchema),
  }),
  // The prompt box's transport (task #11). `prompt` is the streaming leg —
  // oRPC's `eventIterator` output (an async generator over the same
  // `/api/rpc` fetch endpoint everything else in this contract already uses,
  // via chunked SSE-shaped framing under the hood) rather than a second,
  // parallel SSE/WS mechanism. This app is oRPC end-to-end already
  // (`router.ts`'s docstring, `/api/rpc`'s single mount point); a bespoke
  // `ReadableStream` route would duplicate that transport for no gain, since
  // `@orpc/server`'s fetch adapter composes with a Next.js route handler
  // exactly like every non-streaming procedure here already does (verified:
  // `RPCHandler`'s fetch adapter returns a `Response` whose body is the
  // iterator turned into a stream — Next's route handlers stream a
  // `Response` body natively, nothing route-handler-specific to fight).
  sessions: oc.router({
    /** One `session/new` per prompt-box conversation (not per prompt) — reused across multiple `prompt` calls exactly like a real ACP client would. */
    start: oc.input(StartAgentSessionInputSchema).output(StartAgentSessionOutputSchema),
    prompt: oc
      .input(PromptAgentSessionInputSchema)
      .output(eventIterator(AgentSessionStreamEventVOSchema)),
    /** No streaming needed for this direction — an ordinary mutation the browser fires when the user clicks an option on a `permission_request` card. */
    answerPermission: oc
      .input(AnswerAgentSessionPermissionInputSchema)
      .output(AnswerAgentSessionPermissionOutputSchema),
    /**
     * Best-effort `session/cancel` for a conversation the user is walking
     * away from without ever sending a prompt (sheet closed right after
     * opening, or React re-mounting the hook) — found by real e2e
     * verification: without this, EVERY `sessions.start` leaves a real
     * spawned agent process running forever with nothing that will ever
     * prompt or cancel it. Fire-and-forget from the browser's point of view
     * (called from a `useEffect` cleanup, which cannot `await`).
     */
    end: oc.input(EndAgentSessionInputSchema).output(z.object({ ok: z.boolean() })),
    /**
     * Real persisted history, in `seq` order (task #12 step 3) — reads back
     * `acprouter_agent_session_events`, the durable log every event above
     * writes to as it's relayed. An ordinary request/response, not another
     * `eventIterator`: this returns what's ALREADY happened, it doesn't
     * watch for more (a reconnect-and-keep-watching UX is explicitly
     * downstream of this task, see `sessions-logic.ts`'s notes).
     */
    history: oc
      .input(GetAgentSessionHistoryInputSchema)
      .output(z.array(AgentSessionStreamEventVOSchema)),
  }),
});
