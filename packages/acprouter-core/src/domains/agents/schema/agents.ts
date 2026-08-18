import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { acprouterMachines } from "./machines";

/**
 * The two MVP kinds (spec §5.2) — there is no third: the Router never spawns
 * an agent itself.
 */
export type AgentKind = "bridged" | "remote-acp";
export type AgentStatus = "connected" | "disconnected" | "auth_required" | "error";

export const acprouterAgents = pgTable(
  "acprouter_agents",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    // Null for `remote-acp` (e.g. Buda) — nothing to launch, no machine involved.
    machineId: text("machine_id").references(() => acprouterMachines.id),
    kind: text("kind").$type<AgentKind>().notNull(),
    // The registry slug resolves to a pinned `distribution` (npx/binary/uvx) —
    // spawning is data, not per-agent code (spec §5.2).
    registrySlug: text("registry_slug"),
    distribution: jsonb("distribution").$type<Record<string, unknown>>(),
    label: text("label").notNull(),
    // `bridged` only. Chosen locally by the person at the machine, never set
    // by the server — a server-supplied cwd would let a hostile Router point
    // an agent at `~/.ssh` (spec §5.6/§8.2).
    cwd: text("cwd"),
    // `remote-acp` only.
    endpoint: text("endpoint"),
    credentialId: text("credential_id"),
    detectedVersion: text("detected_version"),
    // Raw `initialize` response capabilities — negotiated per agent, never
    // assumed globally (spec §5.2a: e.g. `sessionResume` exists on well under
    // half of real ACP agents).
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
    // Human-readable "exact next step" the CLI reported over the `initialize`
    // `_meta` channel (task #10) — e.g. `formatAuthStatus`'s sign-in
    // instructions, or a probe-failure message. Kept as its own column
    // rather than folded into `capabilities` above: that field is reserved
    // for the spawned inner agent's raw negotiated capabilities (a different
    // concern, task #11+), and mixing the two would risk a future real
    // capability write silently clobbering the status text acceptance
    // criterion 10 depends on.
    statusDetail: text("status_detail"),
    status: text("status").$type<AgentStatus>().notNull().default("disconnected"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("acprouter_agents_owner_idx").on(table.ownerId),
    index("acprouter_agents_machine_idx").on(table.machineId),
    // One row per (machine, registry slug) — the MVP CLI is single-agent-
    // per-machine (spec §5.6 point 4 is explicit that several-agents-per-
    // machine is a future CLI capability, not built here), so this is the
    // natural key for the `initialize`-`_meta` upsert (task #10) instead of
    // inventing a second lookup id. `remote-acp` rows (`machineId` NULL)
    // don't use this pairing at all, and Postgres treats NULLs as distinct
    // in a unique index, so they're unaffected.
    uniqueIndex("acprouter_agents_machine_registry_slug_idx").on(
      table.machineId,
      table.registrySlug,
    ),
  ],
);

export type AgentPO = typeof acprouterAgents.$inferSelect;
export type AgentInsertPO = typeof acprouterAgents.$inferInsert;
