import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { acprouterAgents } from "./agents";
import { acprouterConsumerApiKeys } from "./consumer-api-keys";
import { acprouterMachines } from "./machines";
import { acprouterRouterEnrollmentGrants } from "./router-enrollment-grants";

/**
 * One row per Busabase-driven consumer-key hash registration (Task 5.2/5.3,
 * design.md Decision 7) — binds the triple that `registerConsumerKeyHash`
 * must treat as a single idempotent unit: which grant registered it, which
 * enrolled machine (`enrollmentId`, the documented `machineId` alias from
 * Task 4.4) it's for, and which real `acprouterConsumerApiKeys` row carries
 * the actual hash. Not a duplicate hash store — the hash itself still only
 * ever lives on `acprouterConsumerApiKeys.keyHash`; this table is what makes
 * "same (grantId, enrollmentId) retried with the same hash" answerable
 * without re-deriving an agent or re-checking readiness every time.
 *
 * `revokedAt` is a tombstone, never a delete (Task 5.3: "revoke derived
 * credentials and keep tombstones") — set by the abandoned-completion
 * cleanup, or by the Task 5.4 grant-revocation cascade. A revoked completion
 * blocks a same-hash retry from silently reopening a dead registration;
 * callers must re-register from scratch (a new row) rather than this one
 * un-tombstoning itself.
 *
 * `activatedAt` is a SEPARATE durable marker from `revokedAt` — set exactly
 * once, idempotently, by the activation endpoint Busabase calls AFTER it has
 * durably committed its own local vault entry for the registered hash. This
 * is deliberately independent of whether the device has ever bridged: the
 * abandoned-completion cleanup's 10-minute deadline (design.md Decision 7)
 * fires off `activatedAt IS NULL AND createdAt < now() - 10min`, NOT off the
 * machine's own 2-minute bridge-start deadline (`BRIDGE_START_DEADLINE_MS`,
 * Task 4.5) — those are two different failure conditions ("never bridged in
 * time" vs. "registered a key but Busabase never confirmed it actually
 * activated the pairing") and must not be conflated into one check. Once
 * `activatedAt` is set, the completion is permanently exempt from that
 * cleanup sweep, no matter how much time has elapsed since `createdAt`.
 */
export const acprouterEnrollmentCompletions = pgTable(
  "acprouter_enrollment_completions",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => acprouterRouterEnrollmentGrants.id),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => acprouterMachines.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => acprouterAgents.id),
    consumerKeyId: text("consumer_key_id")
      .notNull()
      .references(() => acprouterConsumerApiKeys.id),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { mode: "date" }),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    // Decision 7's literal constraint: "binds its ID to (grantId,
    // enrollmentId) under a unique constraint" — scoped to LIVE rows only
    // (`WHERE revoked_at IS NULL`), not the whole table: Task 5.3 explicitly
    // requires that an abandoned/revoked completion be re-registerable
    // ("require a new pairing rather than silently reopening completed
    // enrollment"), which means a NEW row for the same (grantId,
    // enrollmentId) pair must be insertable once the old one is tombstoned —
    // an unconditional unique index would make that permanently impossible.
    uniqueIndex("acprouter_enrollment_completions_grant_enrollment_idx")
      .on(table.grantId, table.enrollmentId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("acprouter_enrollment_completions_agent_idx").on(table.agentId),
  ],
);

export type EnrollmentCompletionPO = typeof acprouterEnrollmentCompletions.$inferSelect;
export type EnrollmentCompletionInsertPO = typeof acprouterEnrollmentCompletions.$inferInsert;
