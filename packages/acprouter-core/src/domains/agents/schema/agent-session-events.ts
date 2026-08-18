import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { acprouterAgentSessions } from "./agent-sessions";

/**
 * Append-only log of `session/update` (and permission-request) notifications
 * — needed because ACP v1 has no transport-level resume: a reconnect is a
 * new connection, and messages emitted while disconnected are not replayed
 * (spec §5.4). This is what lets a consumer reconnecting mid-turn see what
 * it missed instead of losing the middle of the answer.
 *
 * `createdAt` is indexed for the retention/pruning sweep task #12 ships in
 * the same pass it starts writing to this table — tool-call chunks are
 * chatty and this table is not meant to grow unbounded.
 */
export const acprouterAgentSessionEvents = pgTable(
  "acprouter_agent_session_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => acprouterAgentSessions.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("acprouter_agent_session_events_session_seq_idx").on(table.sessionId, table.seq),
    index("acprouter_agent_session_events_created_at_idx").on(table.createdAt),
  ],
);

export type AgentSessionEventPO = typeof acprouterAgentSessionEvents.$inferSelect;
export type AgentSessionEventInsertPO = typeof acprouterAgentSessionEvents.$inferInsert;
