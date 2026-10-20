import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { acprouterRouterEnrollmentGrants } from "./router-enrollment-grants";

/**
 * A machine bridged to the Router via `acprouter-cli` (spec §5.2/§7). Rows
 * for a tunnel created on the OSS edition land in that machine's own
 * database, not the hosted edition's — see spec §7's note on where a
 * connection physically lives.
 */
export type MachineStatus = "online" | "offline";

/**
 * How this machine was onboarded (Task 4.1 / design.md Decision 5). The
 * pre-existing anonymous `v1/machines/redeem` path (`"legacy"`) and the new
 * OAuth-enrollment-grant-sourced transactional path (`"oauth-enrollment"`)
 * are deliberately distinguished here, not inferred: the bridge WS route
 * only enforces the new header-borne bridge credential for the latter,
 * exactly matching the design's "only for machines whose row records
 * `enrolledVia: oauth-enrollment`" requirement — a stored, trusted value, not
 * something a caller can assert about itself at connect time.
 */
export type MachineEnrolledVia = "legacy" | "oauth-enrollment";

export const acprouterMachines = pgTable(
  "acprouter_machines",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    label: text("label").notNull(),
    tunnelId: text("tunnel_id").notNull(),
    platform: text("platform"),
    cliVersion: text("cli_version"),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }),
    status: text("status").$type<MachineStatus>().notNull().default("offline"),
    enrolledVia: text("enrolled_via").$type<MachineEnrolledVia>().notNull().default("legacy"),
    /**
     * Set only for `enrolledVia: "oauth-enrollment"` rows (nullable for
     * every pre-existing/legacy row, which has no grant at all) — the Task
     * 4.1 FK letting reachability (mint/status/completion) and the Task 5.4
     * revocation cascade filter by `grantId`, not merely `spaceId` (Decision
     * 6: a space may have multiple grants over time).
     */
    grantId: text("grant_id").references(() => acprouterRouterEnrollmentGrants.id),
    /**
     * Set only for `enrolledVia: "oauth-enrollment"` rows, at redeem time —
     * the independent ~2-minute bridge-start deadline (Task 4.5), tracked
     * separately from the enrollment token's own 10-minute TTL (that TTL
     * governs redeeming the TOKEN; this one governs how long a successfully
     * redeemed machine has to actually complete its first real bridge
     * handshake before it's reported as `failed`).
     */
    bridgeDeadlineAt: timestamp("bridge_deadline_at", { mode: "date" }),
    /**
     * Set only once, by `markMachineOnline`, the first time this machine's
     * bridge WS completes a REAL ACP `initialize` handshake — distinct from
     * `status`, which the legacy AND oauth-enrollment redeem paths both set
     * to `"online"` eagerly at redeem time (pre-existing behavior, unchanged
     * here). Without this separate signal there would be no way to tell
     * "just redeemed, deadline not elapsed yet" apart from "a bridge has
     * actually connected at least once" for the Task 4.5/4.4 status endpoint.
     */
    bridgeConnectedAt: timestamp("bridge_connected_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("acprouter_machines_owner_idx").on(table.ownerId),
    index("acprouter_machines_tunnel_idx").on(table.tunnelId),
    index("acprouter_machines_grant_idx").on(table.grantId),
  ],
);

export type MachinePO = typeof acprouterMachines.$inferSelect;
export type MachineInsertPO = typeof acprouterMachines.$inferInsert;

/**
 * The new path's bridge credential (Decision 5 point 1) — same hash-stored,
 * equality-checked shape as `acprouterConsumerApiKeys`, but a distinct table
 * because the direction of authentication is opposite (machine-into-Router,
 * not consumer-into-Router) and this credential's lifecycle is tied 1:1 to
 * the machine row that owns it, created in the SAME transaction as that
 * machine row and the enrollment-token claim (Task 4.2).
 */
export const acprouterMachineBridgeCredentials = pgTable(
  "acprouter_machine_bridge_credentials",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id")
      .notNull()
      .references(() => acprouterMachines.id),
    credentialHash: text("credential_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    index("acprouter_machine_bridge_credentials_machine_idx").on(table.machineId),
    index("acprouter_machine_bridge_credentials_hash_idx").on(table.credentialHash),
  ],
);

export type MachineBridgeCredentialPO = typeof acprouterMachineBridgeCredentials.$inferSelect;
export type MachineBridgeCredentialInsertPO = typeof acprouterMachineBridgeCredentials.$inferInsert;
