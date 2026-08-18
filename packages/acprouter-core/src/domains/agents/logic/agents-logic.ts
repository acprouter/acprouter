import type { AgentVO } from "@acprouter/contract";
import { and, desc, eq } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import { resolveOwnerId } from "../../../context";
import type { Database } from "../../../db";
import { acprouterAgents } from "../../../db/schema";
import type { AgentPO, AgentStatus } from "../schema/agents";

/** Exported for task #13's `remote-agents-logic.ts`, which inserts a `remote-acp` row directly (no upsert-by-`_meta` path exists for that kind — see that file) and needs the same PO→VO shape back rather than a third copy of this mapping. */
export function toAgentVO(row: AgentPO): AgentVO {
  return {
    id: row.id,
    kind: row.kind,
    registrySlug: row.registrySlug,
    label: row.label,
    machineId: row.machineId,
    cwd: row.cwd,
    detectedVersion: row.detectedVersion,
    status: row.status,
    statusDetail: row.statusDetail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Real registered rows (task #10) — `machines.list`'s counterpart for agents. */
export async function listAgents(db: Database): Promise<AgentVO[]> {
  const rows = await db
    .select()
    .from(acprouterAgents)
    .where(eq(acprouterAgents.ownerId, resolveOwnerId()))
    .orderBy(desc(acprouterAgents.createdAt));
  return rows.map(toAgentVO);
}

/** Looks up the raw PO (not the VO) — task #11's `sessions-logic.ts` needs `machineId` to find the live bridge, which `AgentVO` deliberately doesn't carry to the browser as anything more than an opaque `machineId` string it never dials itself. */
export async function getAgentById(db: Database, agentId: string): Promise<AgentPO | undefined> {
  const [row] = await db
    .select()
    .from(acprouterAgents)
    .where(and(eq(acprouterAgents.id, agentId), eq(acprouterAgents.ownerId, resolveOwnerId())))
    .limit(1);
  return row;
}

export interface UpsertBridgedAgentInput {
  ownerId: string;
  machineId: string;
  registrySlug: string;
  label: string;
  cwd: string | null;
  detectedVersion: string | null;
  status: AgentStatus;
  /** The acceptance-criterion-10 "exact next step" string, if any (task #10). */
  statusDetail?: string | null;
}

/**
 * Upserts the one `bridged` agent row for a `(machineId, registrySlug)` pair
 * — the shape the schema's unique index now enforces (spec §5.6 point 4: the
 * MVP CLI is single-agent-per-machine, so this pairing is a stable natural
 * key, not a guess). Called from `machine-bridge-connection.ts` every time a
 * machine's `initialize` response carries a usable `_meta` (task #10's new
 * channel), so a machine that reconnects with a changed `cwd` or a resolved
 * `auth_required` state overwrites the same row rather than accumulating
 * stale duplicates.
 */
export async function upsertBridgedAgent(
  db: Database,
  input: UpsertBridgedAgentInput,
): Promise<void> {
  const [existing] = await db
    .select({ id: acprouterAgents.id })
    .from(acprouterAgents)
    .where(
      and(
        eq(acprouterAgents.machineId, input.machineId),
        eq(acprouterAgents.registrySlug, input.registrySlug),
      ),
    )
    .limit(1);

  const statusDetail = input.statusDetail ?? null;

  if (existing) {
    await db
      .update(acprouterAgents)
      .set({
        label: input.label,
        cwd: input.cwd,
        detectedVersion: input.detectedVersion,
        status: input.status,
        statusDetail,
        updatedAt: new Date(),
      })
      .where(eq(acprouterAgents.id, existing.id));
    return;
  }

  await db.insert(acprouterAgents).values({
    id: generateNanoID("agt_"),
    ownerId: input.ownerId,
    machineId: input.machineId,
    kind: "bridged",
    registrySlug: input.registrySlug,
    label: input.label,
    cwd: input.cwd,
    detectedVersion: input.detectedVersion,
    status: input.status,
    statusDetail,
  });
}

/**
 * Flips every agent row belonging to a machine to `disconnected` the instant
 * its bridge socket closes — called alongside `markMachineOffline` from the
 * same socket-close handler in `machine-bridge-connection.ts`, so an agent
 * card never keeps reading `connected` after the machine it lives on has
 * gone away (spec §3: "reads as data loss" is exactly the failure mode this
 * closes). Never throws over a machine with no agent rows yet (an older CLI
 * that never sent `_meta`, or one enrolled with no `intendedAgentSlug`) —
 * same "best effort, nothing to report" posture as `markMachineOffline`.
 */
export async function markAgentsDisconnected(db: Database, machineId: string): Promise<void> {
  await db
    .update(acprouterAgents)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(acprouterAgents.machineId, machineId));
}
