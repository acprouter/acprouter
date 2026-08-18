import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A machine bridged to the Router via `acprouter-cli` (spec §5.2/§7). Rows
 * for a tunnel created on the OSS edition land in that machine's own
 * database, not the hosted edition's — see spec §7's note on where a
 * connection physically lives.
 */
export type MachineStatus = "online" | "offline";

export const acprouterMachines = pgTable(
  "acprouter_machines",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    label: text("label").notNull(),
    tunnelId: text("tunnel_id").notNull(),
    platform: text("platform"),
    cliVersion: text("cli_version"),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }),
    status: text("status").$type<MachineStatus>().notNull().default("offline"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("acprouter_machines_owner_idx").on(table.ownerId),
    index("acprouter_machines_tunnel_idx").on(table.tunnelId),
  ],
);

export type MachinePO = typeof acprouterMachines.$inferSelect;
export type MachineInsertPO = typeof acprouterMachines.$inferInsert;
