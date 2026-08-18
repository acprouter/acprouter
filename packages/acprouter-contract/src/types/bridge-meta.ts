import { z } from "zod";

/**
 * Wire shape a machine attaches as `_meta` on its ACP `initialize` RESPONSE
 * (machine → Router). This is task #10's channel: rather than a second
 * connection or a poll, the machine's own `bridge-agent.ts` (the ACP AGENT
 * app the Router's `initialize` REQUEST lands on) piggybacks its current
 * `DeviceConfig` — which agent it's bridging, what directory, and its
 * connect-time auth probe result — onto the response `_meta`, the same
 * protocol extension point task #8 already used the other direction for
 * `_meta.registrySlug` on `session/new`. Kept flat and every field
 * independently nullable/optional so an old CLI build that predates this
 * task (whose `initialize` response simply has no `_meta`) or a partially
 * malformed one degrades to "nothing to report yet" rather than a crash —
 * see `parseBridgeInitializeMeta`.
 */
export const BridgeInitializeMetaSchema = z.object({
  /** The catalog slug this machine is bridging (spec §5.2) — null if this machine was enrolled without one. */
  registrySlug: z.string().nullable(),
  /** The absolute working directory the CLI runs the agent in, chosen locally (spec §5.6). */
  cwd: z.string().nullable(),
  /** From a fresh `detectAgent()` probe at handshake time — not cached from connect-time, so a version bump between connects is reflected on the next reconnect. */
  detectedVersion: z.string().nullable(),
  /** Mirrors the CLI's `AuthStatus["state"]` (task #9) — flattened instead of nesting the discriminated union so the Router side can validate it as a plain enum. Null means no auth probe ever ran for this machine (e.g. no `intendedAgentSlug`). */
  authState: z.enum(["ok", "sign_in_needed", "probe_failed"]).nullable(),
  /** The matching `AuthStatus["detail"]` string — null for `"ok"` and for a null `authState`. */
  authDetail: z.string().nullable(),
});
export type BridgeInitializeMeta = z.infer<typeof BridgeInitializeMetaSchema>;

/**
 * Defensive parse for the Router side (spec: a malformed or missing `_meta`
 * from an old or misbehaving CLI must never crash the bridge connection).
 * `unknown` in, `null` out on anything that doesn't validate — the caller's
 * contract is "no `_meta` to act on", not an error to propagate.
 */
export function parseBridgeInitializeMeta(meta: unknown): BridgeInitializeMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const result = BridgeInitializeMetaSchema.safeParse(meta);
  return result.success ? result.data : null;
}
