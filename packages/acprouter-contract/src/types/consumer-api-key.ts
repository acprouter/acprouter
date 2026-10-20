import { z } from "zod";

/**
 * The credential an external ACP consumer presents to `wss://<router>/api/acp
 * ?agentId=<id>` (spec §5.3 point 1, task #14). Never carries the raw secret —
 * see `MintConsumerApiKeyOutputSchema` below for the one place the raw value
 * is ever returned, exactly once, matching the enrollment-token UX precedent
 * (`MintEnrollmentTokenOutputSchema` in `machine.ts`).
 */
export const ConsumerApiKeyVOSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ConsumerApiKeyVO = z.infer<typeof ConsumerApiKeyVOSchema>;

export const ListConsumerApiKeysInputSchema = z.object({
  agentId: z.string(),
});
export type ListConsumerApiKeysInput = z.infer<typeof ListConsumerApiKeysInputSchema>;

export const MintConsumerApiKeyInputSchema = z.object({
  agentId: z.string(),
  label: z.string().optional(),
});
export type MintConsumerApiKeyInput = z.infer<typeof MintConsumerApiKeyInputSchema>;

export const MintConsumerApiKeyOutputSchema = z.object({
  key: ConsumerApiKeyVOSchema,
  /** Shown once, never retrievable again — same posture as `MintEnrollmentTokenOutput.token`. */
  rawKey: z.string(),
  /** The exact `wss://.../api/acp?agentId=...` URL this key connects to — saves the dashboard from re-deriving the Router's own origin. */
  connectionUrl: z.string(),
});
export type MintConsumerApiKeyOutput = z.infer<typeof MintConsumerApiKeyOutputSchema>;

export const RevokeConsumerApiKeyInputSchema = z.object({
  id: z.string(),
});
export type RevokeConsumerApiKeyInput = z.infer<typeof RevokeConsumerApiKeyInputSchema>;

export const RevokeConsumerApiKeyOutputSchema = z.object({
  ok: z.boolean(),
});
export type RevokeConsumerApiKeyOutput = z.infer<typeof RevokeConsumerApiKeyOutputSchema>;

/**
 * The grant-scoped idempotent completion endpoint (Task 5.2, design.md
 * Decision 7) — Busabase supplies a validated SHA-256 hex digest it already
 * generated and persisted itself; Router never sees or mints the raw secret
 * here. `enrollmentId` is the same `machineId` alias Task 4.4 established.
 */
export const RegisterConsumerKeyHashInputSchema = z.object({
  enrollmentId: z.string(),
  consumerKeyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "consumerKeyHash must be a lowercase hex-encoded SHA-256 digest"),
});
export type RegisterConsumerKeyHashInput = z.infer<typeof RegisterConsumerKeyHashInputSchema>;

/**
 * `"registered"` (first call) and `"already_registered"` (same-hash retry)
 * return identical nonsecret metadata, per Decision 7 — a retrying caller
 * cannot tell the two apart from the response shape alone, on purpose.
 * `"rejected"` never includes `key`/`agentId`/`connectionUrl`.
 */
export const RegisterConsumerKeyHashOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.enum(["registered", "already_registered"]),
    key: ConsumerApiKeyVOSchema,
    agentId: z.string(),
    connectionUrl: z.string(),
  }),
  z.object({
    outcome: z.literal("rejected"),
    reason: z.enum(["agent_not_ready", "hash_mismatch"]),
  }),
]);
export type RegisterConsumerKeyHashOutput = z.infer<typeof RegisterConsumerKeyHashOutputSchema>;

/**
 * The activation marker call (Decision 7, Codex interim review blocker 5) —
 * Busabase calls this AFTER it has durably committed its own local vault
 * entry for the hash `registerConsumerKeyHash` just registered. Scoped by
 * the same `(grantId, enrollmentId)` pair as the completion itself; carries
 * no secret, just a nonsecret confirmation that the pairing is now live.
 */
export const ActivateEnrollmentCompletionInputSchema = z.object({
  enrollmentId: z.string(),
});
export type ActivateEnrollmentCompletionInput = z.infer<
  typeof ActivateEnrollmentCompletionInputSchema
>;

export const ActivateEnrollmentCompletionOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("activated") }),
  z.object({ outcome: z.literal("not_found") }),
]);
export type ActivateEnrollmentCompletionOutput = z.infer<
  typeof ActivateEnrollmentCompletionOutputSchema
>;

/**
 * Device-scoped revoke (post-draft review fix) — the grant-authenticated
 * counterpart to RFC 7009 `/api/oauth/revoke`, which tears down the WHOLE
 * grant/token. This revokes exactly one enrolled device's reachable
 * consumer key, enrollment completion, and bridge credential, leaving the
 * grant and every sibling device enrolled under it untouched. Scoped by the
 * same `(grantId, enrollmentId)` pair as the completion/activation calls.
 */
export const RevokeEnrollmentDeviceInputSchema = z.object({
  enrollmentId: z.string(),
});
export type RevokeEnrollmentDeviceInput = z.infer<typeof RevokeEnrollmentDeviceInputSchema>;

export const RevokeEnrollmentDeviceOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("revoked") }),
  z.object({ outcome: z.literal("not_found") }),
]);
export type RevokeEnrollmentDeviceOutput = z.infer<typeof RevokeEnrollmentDeviceOutputSchema>;
