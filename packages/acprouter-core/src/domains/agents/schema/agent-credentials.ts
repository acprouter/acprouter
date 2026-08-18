import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { acprouterAgents } from "./agents";

/**
 * Own table, own encryption-at-rest — not the user-facing vault, different
 * threat model (spec §7). Never returned to the client in plaintext; only
 * `logic/` reads `encryptedPayload`.
 */
export type AgentCredentialKind = "enrollment_token" | "remote_api_key" | "oauth";

export const acprouterAgentCredentials = pgTable(
  "acprouter_agent_credentials",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => acprouterAgents.id),
    kind: text("kind").$type<AgentCredentialKind>().notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("acprouter_agent_credentials_agent_idx").on(table.agentId)],
);

export type AgentCredentialPO = typeof acprouterAgentCredentials.$inferSelect;
export type AgentCredentialInsertPO = typeof acprouterAgentCredentials.$inferInsert;
