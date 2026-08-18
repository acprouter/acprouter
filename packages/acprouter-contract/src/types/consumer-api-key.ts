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
