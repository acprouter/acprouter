import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { acprouterAgents } from "./agents";

/** One row per ACP `session/new` — what makes cross-device resume (Story E) possible. */
export type AgentSessionStatus = "active" | "idle" | "ended" | "failed";

export const acprouterAgentSessions = pgTable(
  "acprouter_agent_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => acprouterAgents.id),
    // Who opened this session — a user, an oauth client, or an api key
    // (spec §7's `agent_grants` shape, once sharing lands).
    consumerId: text("consumer_id"),
    status: text("status").$type<AgentSessionStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (table) => [
    index("acprouter_agent_sessions_agent_idx").on(table.agentId),
    index("acprouter_agent_sessions_consumer_idx").on(table.consumerId),
  ],
);

export type AgentSessionPO = typeof acprouterAgentSessions.$inferSelect;
export type AgentSessionInsertPO = typeof acprouterAgentSessions.$inferInsert;
