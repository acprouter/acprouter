import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("acprouter_enrollment_tokens_hash_idx").on(table.tokenHash)],
);

export type EnrollmentTokenPO = typeof acprouterEnrollmentTokens.$inferSelect;
export type EnrollmentTokenInsertPO = typeof acprouterEnrollmentTokens.$inferInsert;
