import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { acprouterAgents } from "./agents";

/**
 * The credential external ACP consumers (spec §5.3 point 1 — `wss://<router>
 * /api/acp?agentId=<id>` with a bearer credential) authenticate with. Deliberately
 * its own table, not a new `kind` on `acprouter_agent_credentials`: that table
 * stores what the Router uses to dial OUT to a `remote-acp` backend (Buda) and
 * must be reversible — `decryptAgentApiKey` reads the plaintext back out to put
 * on the wire (`remote-agents-logic.ts`). A consumer API key runs the opposite
 * direction — something a caller presents INTO the Router — so it only ever
 * needs equality-checking, never decrypting, which is exactly the enrollment
 * token shape (`enrollment-tokens.ts`'s `tokenHash`), not the encrypted-payload
 * shape. Reusing `acprouter_agent_credentials` here would mean either storing a
 * hash in a column literally named `encryptedPayload` (misleading) or teaching
 * that table two unrelated verification strategies keyed off `kind` — a new,
 * narrow table is the smaller and more honest fit.
 *
 * One key == one agent (not Router-wide): the spec's own steer is "one owner,
 * their machines, their agents," and per-agent keys are what let an operator
 * hand different external products different keys without any grants model
 * (deliberately out of scope, spec §9 Phase 4) — revoking one product's access
 * later doesn't touch any other product's key.
 *
 * No `expiresAt` — per the task brief, this credential's only job in OSS is
 * "you have to know a real secret," not "here's what you're allowed to do with
 * it or until when." `revokedAt` (not a delete) is enough to answer "list keys,
 * delete one" without losing the audit trail of what a since-revoked key was
 * ever able to reach.
 */
export const acprouterConsumerApiKeys = pgTable(
  "acprouter_consumer_api_keys",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => acprouterAgents.id),
    label: text("label"),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    index("acprouter_consumer_api_keys_agent_idx").on(table.agentId),
    uniqueIndex("acprouter_consumer_api_keys_hash_idx").on(table.keyHash),
  ],
);

export type ConsumerApiKeyPO = typeof acprouterConsumerApiKeys.$inferSelect;
export type ConsumerApiKeyInsertPO = typeof acprouterConsumerApiKeys.$inferInsert;
