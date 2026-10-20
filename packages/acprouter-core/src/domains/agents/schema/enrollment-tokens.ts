import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { acprouterRouterEnrollmentGrants } from "./router-enrollment-grants";

/**
 * Single-use, short-TTL tokens the "Add" dialog mints and the CLI redeems
 * (spec §7): this string gets pasted into terminals, chat windows and
 * screenshots, so a leaked one must be worthless. `usedAt` is set atomically
 * on redemption by `logic/` — enforcement lives there, not in this schema,
 * but `tokenHash` (never the raw token) plus `usedAt`/`expiresAt` are what
 * that check runs against.
 */
export const acprouterEnrollmentTokens = pgTable(
  "acprouter_enrollment_tokens",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    intendedAgentSlug: text("intended_agent_slug"),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { mode: "date" }),
    /**
     * Set only by the new OAuth-bearer-authenticated mint procedure (Task
     * 4.2), null for every pre-existing/legacy-minted token. This is the
     * STORED, trusted signal `redeemEnrollmentToken` dispatches on to choose
     * the transactional `oauth-enrollment` branch vs. the legacy two-statement
     * branch — never a caller-supplied flag (design.md: "Cloud redeem handler
     * dispatches by trusted stored token kind; never by a CLI-supplied legacy
     * flag").
     */
    grantId: text("grant_id").references(() => acprouterRouterEnrollmentGrants.id),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("acprouter_enrollment_tokens_hash_idx").on(table.tokenHash)],
);

export type EnrollmentTokenPO = typeof acprouterEnrollmentTokens.$inferSelect;
export type EnrollmentTokenInsertPO = typeof acprouterEnrollmentTokens.$inferInsert;
