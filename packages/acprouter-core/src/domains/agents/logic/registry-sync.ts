import type { AgentCatalogEntryVO } from "@acprouter/contract";
import pinnedProtocolMatrix from "../registry/pinned-protocol-matrix.json";
import pinnedRegistry from "../registry/pinned-registry.json";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MATRIX_URL =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/.protocol-matrix/latest.json";
const FETCH_TIMEOUT_MS = 3000;

/** Spawning is data, not per-agent code (spec §5.2) — this is that data's shape, verified against the live registry. */
export interface RegistryDistribution {
  npx?: { package: string; args?: string[] };
  binary?: { url: string };
  uvx?: { package: string; args?: string[] };
}

export interface RegistryAgentEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  distribution: RegistryDistribution;
}

export interface RegistryCapabilities {
  authMethods: string[];
  protocolVersion: number | null;
  loadSession: boolean;
  sessionResume: boolean;
}

interface RawRegistryFile {
  version: string;
  agents: RegistryAgentEntry[];
}

interface RawMatrixAgent {
  id: string;
  protocolVersion?: number | null;
  authMethods?: string[];
  capabilities?: { loadSession?: boolean; sessionResume?: boolean };
}

interface RawMatrixFile {
  agents: RawMatrixAgent[];
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live-fetches the official registry, falling back to the committed pinned
 * snapshot (spec §6/§9 Phase 1) on any failure — network down, CDN outage,
 * or an air-gapped install. Never throws.
 */
export async function fetchRegistry(): Promise<{
  agents: RegistryAgentEntry[];
  source: "live" | "pinned";
}> {
  try {
    const response = await fetchWithTimeout(REGISTRY_URL, FETCH_TIMEOUT_MS);
    const data = (await response.json()) as RawRegistryFile;
    if (!Array.isArray(data.agents)) throw new Error("malformed registry response");
    return { agents: data.agents, source: "live" };
  } catch {
    return { agents: (pinnedRegistry as RawRegistryFile).agents, source: "pinned" };
  }
}

/**
 * Live-fetches the daily protocol-conformance matrix — the *only* source
 * for capability data; `registry.json` itself carries none (verified). Same
 * pinned-fallback posture as `fetchRegistry`.
 */
export async function fetchProtocolMatrix(): Promise<{
  byId: Map<string, RegistryCapabilities>;
  source: "live" | "pinned";
}> {
  const toMap = (agents: RawMatrixAgent[]): Map<string, RegistryCapabilities> => {
    const map = new Map<string, RegistryCapabilities>();
    for (const agent of agents) {
      map.set(agent.id, {
        authMethods: agent.authMethods ?? [],
        protocolVersion: agent.protocolVersion ?? null,
        loadSession: agent.capabilities?.loadSession ?? false,
        sessionResume: agent.capabilities?.sessionResume ?? false,
      });
    }
    return map;
  };

  try {
    const response = await fetchWithTimeout(MATRIX_URL, FETCH_TIMEOUT_MS);
    const data = (await response.json()) as RawMatrixFile;
    if (!Array.isArray(data.agents)) throw new Error("malformed matrix response");
    return { byId: toMap(data.agents), source: "live" };
  } catch {
    return { byId: toMap((pinnedProtocolMatrix as RawMatrixFile).agents), source: "pinned" };
  }
}

/**
 * Registry-only spawning (spec §8.2), for `acprouter-cli` — never the
 * Router, which never spawns anything (spec §5.1/§5.2). Resolves ONLY
 * against the pinned JSON bundled into this package's own build, unlike
 * `fetchRegistry` above: the whole point of this lookup is that it must not
 * depend on, or be steerable through, a network call at spawn time — a
 * Router that could influence what "the registry" says would defeat the
 * invariant it exists to enforce.
 */
export function resolvePinnedDistribution(registrySlug: string): RegistryDistribution | null {
  const entry = (pinnedRegistry as RawRegistryFile).agents.find((a) => a.id === registrySlug);
  return entry?.distribution ?? null;
}

/** The MVP's bridged catalog entries (spec §9 Phase 1) — resolved against the real registry, not hand-typed. */
const MVP_BRIDGED_SLUGS = ["claude-acp", "codex-acp"] as const;

const MVP_DISPLAY_NAMES: Record<string, string> = {
  "claude-acp": "Claude Code",
  "codex-acp": "Codex",
};

/**
 * Synchronous name lookup for a bridged registry slug — used by
 * `agents-logic.ts`'s `initialize`-`_meta` upsert (task #10), which needs a
 * human label right when a machine reports in and can't afford
 * `getAgentCatalog`'s network fetch (or its fallback latency) on that path.
 * Falls back to the raw slug for anything outside the MVP's two bridged
 * entries rather than throwing — an unrecognized slug is still worth
 * recording with *some* label.
 */
export function displayNameForRegistrySlug(registrySlug: string): string {
  return MVP_DISPLAY_NAMES[registrySlug] ?? registrySlug;
}

/**
 * The full MVP catalog: the two bridged entries resolved from the synced
 * registry, plus Buda — which is `remote-acp` and not eligible for official
 * registry listing at all (no URL-based `distribution` exists), so it
 * stays a static entry rather than something "synced".
 */
export async function getAgentCatalog(): Promise<AgentCatalogEntryVO[]> {
  const { agents, source } = await fetchRegistry();
  const bySlug = new Map(agents.map((a) => [a.id, a]));

  const bridged: AgentCatalogEntryVO[] = MVP_BRIDGED_SLUGS.map((slug) => {
    const entry = bySlug.get(slug);
    return {
      id: slug,
      name: MVP_DISPLAY_NAMES[slug] ?? slug,
      description: entry?.description ?? "Spawned on the machine you connect.",
      kind: "bridged" as const,
      version: entry?.version ?? null,
      source,
    };
  });

  const buda: AgentCatalogEntryVO = {
    id: "buda",
    name: "Buda",
    description: "Already reachable over ACP — no machine or process required.",
    kind: "remote-acp",
    version: null,
    source: "static",
  };

  return [...bridged, buda];
}
