import { z } from "zod";

/**
 * The JSON envelope `encryptAgentApiKey` encrypts for an
 * `acprouter_agent_credentials.kind === "oauth"` row (PUL-335's Buda OAuth
 * connect flow). Its own file with no imports (besides zod) so both
 * `remote-agents-logic.ts` (writes it on connect) and
 * `remote-agent-credential.ts` (reads + refreshes it at dial time) can
 * depend on the shape without creating an import cycle between those two
 * files.
 */
export const StoredOAuthCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  agentId: z.string().min(1),
});

export type StoredOAuthCredential = z.infer<typeof StoredOAuthCredentialSchema>;

/**
 * Buda's `/api/oauth/token` response shape, shared base fields present on
 * BOTH grant types — validated at every boundary that trusts the HTTP
 * response (the OAuth callback route and `remote-agent-credential.ts`'s
 * refresh path) so a non-string token or a non-positive `expires_in` can
 * never be silently accepted and persisted as a usable credential.
 */
const BudaTokenResponseBaseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z
    .number()
    .finite()
    .positive()
    .refine((seconds) => {
      const expiresAt = Date.now() + seconds * 1000;
      return Number.isFinite(expiresAt) && Number.isFinite(new Date(expiresAt).getTime());
    }, "Token expiration must be a representable future date."),
  agent_name: z.string().min(1).optional(),
});

/**
 * The `authorization_code` grant's response — `agent_id` is REQUIRED here:
 * this is the one response that names which Buda agent the new credential
 * is for, with nothing else to fall back to.
 */
export const BudaTokenResponseSchema = BudaTokenResponseBaseSchema.extend({
  agent_id: z.string().min(1),
});

export type BudaTokenResponse = z.infer<typeof BudaTokenResponseSchema>;

/**
 * The `refresh_token` grant's response — Buda's OAuth token endpoint only
 * echoes `agent_id`/`agent_name` back when the underlying grant
 * rotated them, so unlike the initial exchange, `agent_id` here is
 * genuinely optional and must not be required.
 */
export const BudaRefreshTokenResponseSchema = BudaTokenResponseBaseSchema.extend({
  agent_id: z.string().min(1).optional(),
});

export type BudaRefreshTokenResponse = z.infer<typeof BudaRefreshTokenResponseSchema>;

/** Safe JSON.parse + schema validation — never throws, returns null on anything invalid. */
export function parseBudaTokenResponse(raw: unknown): BudaTokenResponse | null {
  const result = BudaTokenResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Same as `parseBudaTokenResponse`, but for a `refresh_token` grant response (`agent_id` optional). */
export function parseBudaRefreshTokenResponse(raw: unknown): BudaRefreshTokenResponse | null {
  const result = BudaRefreshTokenResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Safe JSON.parse of a Buda token HTTP response body — never throws on malformed JSON. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
