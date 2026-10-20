import { z } from "zod";

/** Mirrors `AgentKind`/`AgentStatus` in `packages/acprouter-core/.../schema/agents.ts` — kept as its own zod schema here (not imported from core) because `contract.ts` must never pull in a drizzle-backed module (see this repo's DDD contract-purity rule). */
export const AgentKindSchema = z.enum(["bridged", "remote-acp"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentStatusSchema = z.enum(["connected", "disconnected", "auth_required", "error"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentVOSchema = z.object({
  id: z.string(),
  kind: AgentKindSchema,
  registrySlug: z.string().nullable(),
  label: z.string(),
  machineId: z.string().nullable(),
  /** Always present for a `bridged` agent that has ever reported in (spec §5.6 point 5 — the dashboard must show this, never hide it). Null for `remote-acp` (Buda ignores `cwd`, spec §5.5a) or a row that hasn't reported yet. */
  cwd: z.string().nullable(),
  detectedVersion: z.string().nullable(),
  status: AgentStatusSchema,
  /** The human-readable "exact next step" (acceptance criterion 10) — sign-in instructions for `auth_required`, the failure message for `error`. Null for `connected`/`disconnected`. */
  statusDetail: z.string().nullable(),
  updatedAt: z.string(),
});
export type AgentVO = z.infer<typeof AgentVOSchema>;

/**
 * Task #13's Buda Add flow (spec §2b): "an endpoint field... and an API key
 * field. Submit connects immediately." No `agentId` field of its own — the
 * spec is explicit the dialog only has these two fields, and the user
 * appends their own `?agentId=` onto the pre-filled endpoint value.
 */
export const ConnectRemoteAcpAgentInputSchema = z.object({
  label: z.string().min(1),
  endpoint: z.string().min(1),
  apiKey: z.string().min(1),
});
export type ConnectRemoteAcpAgentInput = z.infer<typeof ConnectRemoteAcpAgentInputSchema>;

/**
 * Soft-removes one of the caller's own agent rows (eligible only when
 * `status` is `"disconnected"` — `connected`, `auth_required`, and `error`
 * are all rejected). Shape mirrors `RevokeConsumerApiKeyInputSchema`/
 * `RevokeConsumerApiKeyOutputSchema` (`types/consumer-api-key.ts`) exactly —
 * the dashboard only needs a yes/no result to know whether to refresh its
 * list, not the removed row's content.
 */
export const RemoveAgentInputSchema = z.object({
  id: z.string(),
});
export type RemoveAgentInput = z.infer<typeof RemoveAgentInputSchema>;

export const RemoveAgentOutputSchema = z.object({
  ok: z.boolean(),
});
export type RemoveAgentOutput = z.infer<typeof RemoveAgentOutputSchema>;
