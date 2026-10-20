/**
 * Grant-revocation cascade's DB-only steps (Task 5.4) — everything that
 * lives inside `@acprouter/core` because it's pure DB mechanics scoped by
 * `grantId`, with no dependency on Cloud's OAuth/membership stack. Cloud's
 * own `grant-revocation-cascade.ts` calls this AFTER (or instead of
 * duplicating) these steps, then layers its own `verifications`-table OAuth
 * cleanup on top — this function is the single place these four effects are
 * implemented, so neither side can drift out of sync with the other.
 *
 * All four steps are scoped strictly by `grantId`, never by `ownerId`/
 * `spaceId` alone (Decision 6: a space may have multiple grants over time;
 * revoking one must never touch a sibling grant's rows):
 *
 * 1. Revoke every live consumer API key reachable from this grant — via the
 *    `acprouterEnrollmentCompletions.grantId` join (that table is what
 *    actually ties a consumer key back to a grant; `acprouterConsumerApiKeys`
 *    itself is agent-scoped, not grant-scoped, by design) — and best-effort
 *    close any live ACP connection authenticated by that key (Codex interim
 *    review blocker 2), via `consumer-acp-registry.ts`. This step updates the
 *    row directly rather than calling `revokeConsumerApiKey` (which would
 *    re-derive the same close call) — both paths end up calling
 *    `closeConsumerAcpConnection`, so neither can drift out of sync.
 * 2. Invalidate every pending/unredeemed enrollment token for this grant —
 *    reuses the exact `usedAt IS NULL` guard `redeemEnrollmentToken` already
 *    checks, so setting `usedAt` here is sufcient to permanently block
 *    redemption without a new column.
 * 3. Revoke every live bridge credential for every machine enrolled under
 *    this grant.
 * 4. Best-effort close any currently-registered live bridge connection for
 *    those same machines, via the existing in-memory registry.
 *
 * Idempotent: re-running against an already-revoked grant touches zero rows
 * (every step's own `WHERE ... IS NULL` guard already excludes anything this
 * cascade already revoked).
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../../db";
import {
  acprouterConsumerApiKeys,
  acprouterEnrollmentCompletions,
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
} from "../../../db/schema";
import { closeConsumerAcpConnection } from "./consumer-acp-registry";
import { getMachineBridge, unregisterMachineBridge } from "./machine-bridge-registry";

export const revokeRouterEnrollmentGrantCascadeCore = async (
  db: Database,
  grantId: string,
): Promise<void> => {
  const completions = await db
    .select({ consumerKeyId: acprouterEnrollmentCompletions.consumerKeyId })
    .from(acprouterEnrollmentCompletions)
    .where(eq(acprouterEnrollmentCompletions.grantId, grantId));
  await db
    .update(acprouterEnrollmentCompletions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(acprouterEnrollmentCompletions.grantId, grantId),
        isNull(acprouterEnrollmentCompletions.revokedAt),
      ),
    );
  for (const completion of completions) {
    await db
      .update(acprouterConsumerApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterConsumerApiKeys.id, completion.consumerKeyId),
          isNull(acprouterConsumerApiKeys.revokedAt),
        ),
      )
      .returning();
    closeConsumerAcpConnection(completion.consumerKeyId, "Enrollment grant revoked");
  }

  await db
    .update(acprouterEnrollmentTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(acprouterEnrollmentTokens.grantId, grantId), isNull(acprouterEnrollmentTokens.usedAt)),
    );

  const machines = await db
    .select({ id: acprouterMachines.id })
    .from(acprouterMachines)
    .where(eq(acprouterMachines.grantId, grantId));
  for (const machine of machines) {
    await db
      .update(acprouterMachineBridgeCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterMachineBridgeCredentials.machineId, machine.id),
          isNull(acprouterMachineBridgeCredentials.revokedAt),
        ),
      );

    const bridge = getMachineBridge(machine.id);
    if (bridge) {
      unregisterMachineBridge(machine.id, bridge.connection);
      try {
        bridge.connection.close();
      } catch {
        /* Continue closing sibling connections. */
      }
    }
  }
};
