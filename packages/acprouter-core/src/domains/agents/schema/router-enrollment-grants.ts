import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The stable authorization subject for the enrollment OAuth resource
 * (`/api/busabase-enrollment`). Every call authenticated by a token minted
 * under that resource re-resolves back to this row's live
 * `(acprouterUserId, acprouterSpaceId)` rather than trusting anything
 * embedded in the token/consent payload itself — membership and `write`
 * permission are re-checked against this pair on every grant-authenticated
 * call (see `grant-membership-check.ts`), so a later membership change takes
 * effect immediately without needing to revoke any token.
 *
 * One row per completed consent — no tuple dedup. Re-authorizing the same
 * (issuer, clientId, user, space) creates a new grantId rather than reusing
 * an old one, so two separate authorizations (e.g. two different Busabase
 * spaces each enrolling the same Router user/space) are independently
 * revocable and never share a cascade.
 */
export const acprouterRouterEnrollmentGrants = pgTable(
  "acprouter_router_enrollment_grants",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    acprouterUserId: text("acprouter_user_id").notNull(),
    acprouterSpaceId: text("acprouter_space_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    index("acprouter_router_enrollment_grants_user_idx").on(table.acprouterUserId),
    index("acprouter_router_enrollment_grants_space_idx").on(table.acprouterSpaceId),
  ],
);

export type RouterEnrollmentGrantPO = typeof acprouterRouterEnrollmentGrants.$inferSelect;
export type RouterEnrollmentGrantInsertPO = typeof acprouterRouterEnrollmentGrants.$inferInsert;
