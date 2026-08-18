import { agentsContract } from "@acprouter/contract";
import { implement } from "@orpc/server";
import type { Context } from "../../context";
import * as agentsLogic from "./logic/agents-logic";
import * as consumerApiKeysLogic from "./logic/consumer-api-keys-logic";
import * as machinesLogic from "./logic/machines-logic";
import * as remoteAgentsLogic from "./logic/remote-agents-logic";
import * as sessionEventsLogic from "./logic/session-events-logic";
import * as sessionsLogic from "./logic/sessions-logic";

const os = implement(agentsContract).$context<Context>();

export const agentsRouter = os.router({
  machines: {
    list: os.machines.list.handler(({ context }) => machinesLogic.listMachines(context.db)),
    mint: os.machines.mint.handler(({ context, input }) =>
      machinesLogic.mintEnrollmentToken(context.db, input, context.serverOrigin),
    ),
  },
  agents: {
    list: os.agents.list.handler(({ context }) => agentsLogic.listAgents(context.db)),
    connectRemoteAcp: os.agents.connectRemoteAcp.handler(({ context, input }) =>
      remoteAgentsLogic.connectRemoteAcpAgent(context.db, input),
    ),
  },
  // Task #14 — mint/list/revoke the bearer credential external ACP
  // consumers present at `wss://<router>/api/acp?agentId=<id>`. Thin per this
  // repo's DDD convention: `consumer-api-keys-logic.ts` owns hashing/storage.
  consumerKeys: {
    list: os.consumerKeys.list.handler(({ context, input }) =>
      consumerApiKeysLogic.listConsumerApiKeys(context.db, input.agentId),
    ),
    mint: os.consumerKeys.mint.handler(({ context, input }) =>
      consumerApiKeysLogic.mintConsumerApiKey(
        context.db,
        input.agentId,
        input.label,
        context.serverOrigin,
      ),
    ),
    revoke: os.consumerKeys.revoke.handler(({ context, input }) =>
      consumerApiKeysLogic.revokeConsumerApiKey(context.db, input.id),
    ),
  },
  // The prompt box's transport (task #11) — see `agentsContract.sessions`'s
  // docstring for why this is an oRPC event iterator rather than a second
  // streaming mechanism. All three handlers stay thin per this repo's DDD
  // convention: `sessions-logic.ts` owns the ACP calls and the relay
  // registry lookups, this file just wires input → logic → output.
  sessions: {
    start: os.sessions.start.handler(({ context, input }) =>
      sessionsLogic.startAgentSession(context.db, input.agentId),
    ),
    prompt: os.sessions.prompt.handler(({ context, input }) =>
      sessionsLogic.promptAgentSession(context.db, input),
    ),
    answerPermission: os.sessions.answerPermission.handler(({ context, input }) =>
      sessionsLogic.answerAgentSessionPermission(context.db, input.sessionId, input.optionId),
    ),
    end: os.sessions.end.handler(({ context, input }) =>
      sessionsLogic.endAgentSession(context.db, input),
    ),
    history: os.sessions.history.handler(({ context, input }) =>
      sessionEventsLogic.listSessionEvents(context.db, input.sessionId),
    ),
  },
});
