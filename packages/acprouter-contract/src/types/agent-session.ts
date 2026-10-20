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

/**
 * A base64 payload the browser attached.
 *
 * `image`/`audio` map to ACP's `ImageContent`/`AudioContent` verbatim; `file`
 * is everything else (a PDF, a spreadsheet, a Markdown note) and becomes an
 * ACP embedded `resource` block at send time. `data` is base64 for every kind
 * — including textual files — so the browser never has to guess an encoding;
 * whether a file travels to the agent as ACP text or as an ACP blob is decided
 * server-side from the payload itself.
 */
export const PromptAttachmentInputSchema = z.object({
  kind: z.enum(["image", "audio", "file"]),
  // ~15 MB of raw bytes once base64 is decoded. A backstop, not the real
  // limit: the composer caps files at 10 MB where it can tell the user why.
  // This only stops a hand-rolled request from turning one prompt into an
  // unbounded request body.
  data: z.string().min(1).max(20_000_000),
  mimeType: z.string().min(1),
  /** The original filename, carried for `file` so the agent and the transcript can name it. */
  filename: z.string().max(255).optional(),
});
export type PromptAttachmentInput = z.infer<typeof PromptAttachmentInputSchema>;

export const PromptAgentSessionInputSchema = z
  .object({
    agentId: z.string(),
    sessionId: z.string(),
    // No longer `.min(1)`: an attachment with no caption is a valid prompt.
    // The refine below is what actually requires SOMETHING to send.
    text: z.string(),
    attachments: z.array(PromptAttachmentInputSchema).optional(),
  })
  .refine((value) => value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0, {
    message: "A prompt needs text, an attachment, or both.",
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
  /**
   * A session-level remark that is not the agent speaking — currently only
   * "this agent could not accept that attachment, here is what happened to
   * it". ACP has no notification for this either: `promptCapabilities` is
   * negotiated at `initialize`, so the fact that a perfectly valid attachment
   * is unsendable to THIS agent is something only the Router knows, and
   * dropping it silently would leave the user with a reply that ignored their
   * file for no visible reason. Not persisted with the turn's events — it
   * explains one send, not the conversation.
   */
  z.object({ type: z.literal("note"), text: z.string() }),
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

/**
 * Narrower than `end`: stops the turn currently in flight without ending the
 * session — the browser's stop button, not its "give up on this
 * conversation" cleanup. `end` also marks the session row `"ended"` and (for
 * `remote-acp`) closes the per-session socket; this does neither.
 */
export const CancelAgentTurnInputSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
});
export type CancelAgentTurnInput = z.infer<typeof CancelAgentTurnInputSchema>;

export const GetAgentSessionHistoryInputSchema = z.object({
  sessionId: z.string(),
});
export type GetAgentSessionHistoryInput = z.infer<typeof GetAgentSessionHistoryInputSchema>;
