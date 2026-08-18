import type * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

/**
 * These four wrap real ACP protocol types (`@agentclientprotocol/sdk`'s "."
 * entry — types only, zero bundle cost) rather than re-deriving the SDK's
 * own generated zod schema for them. The SDK does not publish
 * `dist/schema/zod.gen.js` as part of its public export map (only the
 * top-level `.` entry, which re-exports *types*, not the validators) — so
 * matching it byte-for-byte here would mean either reaching into a
 * non-public dist path (breaks on any SDK internal reshuffle) or hand-
 * duplicating ACP's full nested union shape (drifts from the SDK on every
 * protocol bump, silently). `z.custom<T>()` keeps these values statically
 * typed against the SDK's real types while treating "is it a non-null
 * object" as the runtime check. That's an acceptable trade specifically
 * because this VO only ever crosses the Router's OWN internal `/api/rpc`
 * boundary (no external, untrusted caller — same trust boundary as every
 * other procedure in `agentsContract`, see `router.ts`'s docstring), not a
 * public API surface being defended against adversarial payloads.
 */
const AcpSessionUpdateSchema = z.custom<acp.SessionUpdate>(
  (value) => typeof value === "object" && value !== null && "sessionUpdate" in value,
);
const AcpToolCallUpdateSchema = z.custom<acp.ToolCallUpdate>(
  (value) => typeof value === "object" && value !== null && "toolCallId" in value,
);
const AcpPermissionOptionSchema = z.custom<acp.PermissionOption>(
  (value) => typeof value === "object" && value !== null && "optionId" in value,
);
const AcpStopReasonSchema = z.custom<acp.StopReason>((value) => typeof value === "string");

export const StartAgentSessionInputSchema = z.object({
  agentId: z.string(),
});
export type StartAgentSessionInput = z.infer<typeof StartAgentSessionInputSchema>;

export const StartAgentSessionOutputSchema = z.object({
  sessionId: z.string(),
});
export type StartAgentSessionOutput = z.infer<typeof StartAgentSessionOutputSchema>;

export const PromptAgentSessionInputSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  text: z.string().min(1),
});
export type PromptAgentSessionInput = z.infer<typeof PromptAgentSessionInputSchema>;

/**
 * One item of the browser's streamed turn (task #11). A thin envelope
 * around real ACP wire shapes plus a small set of Router-invented terminal
 * events (`turn_ended`/`session_ended`/`permission_resolved`) that ACP
 * itself has no notification for but the prompt box needs to render —
 * "why did the stream stop" (acceptance criterion 12) has no ACP-native
 * answer, since ACP v1 has no session-lifecycle-ended notification of its
 * own (a `session/prompt` request either resolves with a `stopReason` or the
 * connection errors).
 */
export const AgentSessionStreamEventVOSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_update"), update: AcpSessionUpdateSchema }),
  z.object({
    type: z.literal("permission_request"),
    toolCall: AcpToolCallUpdateSchema,
    options: z.array(AcpPermissionOptionSchema),
    requestedAt: z.string(),
    timeoutAt: z.string(),
  }),
  z.object({
    type: z.literal("permission_resolved"),
    /** Always the real `optionId` a real click chose — a timeout resolves the request internally with `cancelled` but ends the whole SESSION (a distinct `session_ended` event) rather than emitting this event with a synthetic id. */
    optionId: z.string(),
  }),
  z.object({ type: z.literal("turn_ended"), stopReason: AcpStopReasonSchema }),
  z.object({ type: z.literal("session_ended"), reason: z.string() }),
]);
export type AgentSessionStreamEventVO = z.infer<typeof AgentSessionStreamEventVOSchema>;

export const AnswerAgentSessionPermissionInputSchema = z.object({
  sessionId: z.string(),
  optionId: z.string(),
});
export type AnswerAgentSessionPermissionInput = z.infer<
  typeof AnswerAgentSessionPermissionInputSchema
>;

export const AnswerAgentSessionPermissionOutputSchema = z.object({
  /** False when the timeout already fired (or nothing was ever pending) — the browser answered too late; the UI must not claim success it can't back up. */
  answered: z.boolean(),
});
export type AnswerAgentSessionPermissionOutput = z.infer<
  typeof AnswerAgentSessionPermissionOutputSchema
>;

export const EndAgentSessionInputSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
});
export type EndAgentSessionInput = z.infer<typeof EndAgentSessionInputSchema>;

export const GetAgentSessionHistoryInputSchema = z.object({
  sessionId: z.string(),
});
export type GetAgentSessionHistoryInput = z.infer<typeof GetAgentSessionHistoryInputSchema>;
