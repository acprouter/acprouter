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

/**
 * Wire shape a machine attaches as `_meta` on its `session/new` RESPONSE.
 *
 * Separate from `BridgeInitializeMeta` because the fact it carries is
 * per-SESSION, not per-machine: the bridge does not spawn the real agent at
 * `initialize` time at all — it spawns one per `session/new`, chosen by that
 * request's `_meta.registrySlug` — so one machine can be running two
 * different agents, with different capabilities, at the same time. The
 * bridge's own `initialize` response advertises only what the CLI itself
 * implements (`{ loadSession: false }`), which says nothing about the agent
 * eventually spawned behind it.
 *
 * ACP requires `image`, `audio` and embedded `resource` content to be
 * negotiated from the agent's `initialize` (see `buildPromptContent`), and
 * for a bridged agent this response is the only place the Router can learn
 * them. Every field is optional, and a missing `_meta` parses to `null`
 * rather than throwing, so a CLI built before this exists degrades to "no
 * negotiation available" — which `buildPromptContent` already treats as
 * send-everything, i.e. exactly the behaviour that CLI had all along.
 */
export const BridgeSessionMetaSchema = z.object({
  /** Verbatim `agentCapabilities.promptCapabilities` from the SPAWNED agent's own `initialize`. */
  promptCapabilities: z
    .object({
      image: z.boolean().optional(),
      audio: z.boolean().optional(),
      embeddedContext: z.boolean().optional(),
    })
    .optional(),
});
export type BridgeSessionMeta = z.infer<typeof BridgeSessionMetaSchema>;

/** Same defensive contract as `parseBridgeInitializeMeta`: `unknown` in, `null` out on anything that doesn't validate. */
export function parseBridgeSessionMeta(meta: unknown): BridgeSessionMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const result = BridgeSessionMetaSchema.safeParse(meta);
  return result.success ? result.data : null;
}
