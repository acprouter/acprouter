import { z } from "zod";

/**
 * A catalog entry the Agents page can offer to Add — one of the two MVP
 * kinds (spec §5.2): `bridged` (acprouter-cli spawns it on a dialled-in
 * machine) or `remote-acp` (already reachable over ACP, e.g. Buda). There is
 * no third kind — the Router never spawns anything itself.
 */
export const AgentCatalogEntryVOSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["bridged", "remote-acp"]),
  /** Pinned version from the official ACP registry — null for entries with no registry counterpart (Buda). */
  version: z.string().nullable(),
  /** Whether this data came from a live fetch or the committed offline fallback (spec §6.1's "sync task"). */
  source: z.enum(["live", "pinned", "static"]),
});
export type AgentCatalogEntryVO = z.infer<typeof AgentCatalogEntryVOSchema>;
