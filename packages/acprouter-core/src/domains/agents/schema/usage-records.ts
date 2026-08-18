import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { acprouterAgentSessions } from "./agent-sessions";
import { acprouterAgents } from "./agents";

/**
 * Per-call usage — being the gateway is what makes this free to collect
 * (spec §1); not writing it wastes the position. This table is what makes
 * charging later a decision rather than a rebuild (spec §9 Phase 4).
 */
export type UsageOutcome = "success" | "error" | "cancelled";

export const acprouterUsageRecords = pgTable(
  "acprouter_usage_records",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => acprouterAgents.id),
    sessionId: text("session_id").references(() => acprouterAgentSessions.id),
    granteeId: text("grantee_id"),
    durationMs: integer("duration_ms"),
    outcome: text("outcome").$type<UsageOutcome>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("acprouter_usage_records_agent_idx").on(table.agentId),
    index("acprouter_usage_records_grantee_idx").on(table.granteeId),
  ],
);

export type UsageRecordPO = typeof acprouterUsageRecords.$inferSelect;
export type UsageRecordInsertPO = typeof acprouterUsageRecords.$inferInsert;
