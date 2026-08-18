import { z } from "zod";

export const MachineStatusSchema = z.enum(["online", "offline"]);
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

export const MachineVOSchema = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.string().nullable(),
  cliVersion: z.string().nullable(),
  status: MachineStatusSchema,
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MachineVO = z.infer<typeof MachineVOSchema>;

export const MintEnrollmentTokenInputSchema = z.object({
  /** Which catalog entry (spec §5.2) the dashboard's Add dialog was minting for — stored on the token, not the eventual machine (a machine is not an agent type; the CLI's own hostname becomes the machine's label at redeem time). */
  intendedAgentSlug: z.string().min(1).max(200).optional(),
});
export type MintEnrollmentTokenInput = z.infer<typeof MintEnrollmentTokenInputSchema>;

export const MintEnrollmentTokenOutputSchema = z.object({
  /** The future machine's id — reused as the enrollment token's id, so the
   *  dashboard knows what to poll for before redemption happens (spec §7). */
  machineId: z.string(),
  /** Raw one-time token — shown once, never persisted in plaintext. */
  token: z.string(),
  /** The exact command to paste, with server URL + token filled in. */
  command: z.string(),
  expiresAt: z.string(),
});
export type MintEnrollmentTokenOutput = z.infer<typeof MintEnrollmentTokenOutputSchema>;

/** POSTed by `acprouter-cli` to `/api/v1/machines/redeem` — not an oRPC procedure (spec §5.3/§9 Phase 1: the CLI is not a browser oRPC client). */
export const RedeemEnrollmentTokenInputSchema = z.object({
  token: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
  platform: z.string().max(200).optional(),
  cliVersion: z.string().max(50).optional(),
});
export type RedeemEnrollmentTokenInput = z.infer<typeof RedeemEnrollmentTokenInputSchema>;

export const RedeemEnrollmentTokenOutputSchema = z.object({
  machineId: z.string(),
  /** What the dashboard's Add dialog was minting for (spec §5.2) — the CLI uses this to run local detection right after connecting (task #6). */
  intendedAgentSlug: z.string().nullable(),
});
export type RedeemEnrollmentTokenOutput = z.infer<typeof RedeemEnrollmentTokenOutputSchema>;

export const RedeemEnrollmentTokenErrorSchema = z.object({
  error: z.enum(["invalid_token", "expired", "already_used"]),
  message: z.string(),
});
export type RedeemEnrollmentTokenError = z.infer<typeof RedeemEnrollmentTokenErrorSchema>;
