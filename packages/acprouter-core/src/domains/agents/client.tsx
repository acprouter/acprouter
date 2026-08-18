"use client";

import type { agentsContract } from "@acprouter/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createContext, useContext, useMemo } from "react";

export type AcprouterAgentsClient = ContractRouterClient<{ agents: typeof agentsContract }>;

/**
 * `RPCLink` needs an absolute URL (it calls `new URL(...)` internally with
 * no base, which throws on a bare path like `/api/rpc`) — resolve a relative
 * `apiBasePath` against the current origin, same as the old
 * `apps/acprouter`-local `getBaseUrl()` this replaces. An already-absolute
 * `apiBasePath` (a future host app passing a full URL) passes through
 * unchanged since `new URL(absolute, base)` ignores `base` in that case.
 */
function resolveApiUrl(apiBasePath: string): string {
  if (typeof window !== "undefined") {
    return new URL(apiBasePath, window.location.origin).toString();
  }
  return apiBasePath;
}

/**
 * Single flat client for the agents dashboard — no react-query layer. This
 * domain has a handful of calls (mint, poll list, session start/prompt); the
 * extra dependency and provider wiring isn't earning its keep yet (mirrors
 * the reasoning that used to live next to apps/acprouter's own, now-removed,
 * `~/lib/orpc-client`).
 *
 * `apiBasePath` is supplied by whichever app mounts this package's
 * components — never hardcoded here — so the SAME components work whether
 * they're mounted at apps/acprouter's `/api/rpc` or a different host app's
 * oRPC endpoint.
 */
export function createAcprouterAgentsClient(apiBasePath: string): AcprouterAgentsClient {
  const link = new RPCLink({
    url: () => resolveApiUrl(apiBasePath),
  });
  return createORPCClient(link);
}

const AcprouterOrpcContext = createContext<AcprouterAgentsClient | null>(null);

interface AcprouterOrpcProviderProps {
  /** Base URL (absolute or relative — resolved by `fetch` like any other request URL) the oRPC client sends requests to, e.g. `/api/rpc`. */
  apiBasePath: string;
  /** Escape hatch for callers that already have a client (e.g. tests) — bypasses `createAcprouterAgentsClient` entirely when provided. */
  client?: AcprouterAgentsClient;
  children: React.ReactNode;
}

export function AcprouterOrpcProvider({
  apiBasePath,
  client,
  children,
}: AcprouterOrpcProviderProps) {
  const value = useMemo(
    () => client ?? createAcprouterAgentsClient(apiBasePath),
    [apiBasePath, client],
  );
  return <AcprouterOrpcContext.Provider value={value}>{children}</AcprouterOrpcContext.Provider>;
}

export function useAcprouterOrpc(): AcprouterAgentsClient {
  const client = useContext(AcprouterOrpcContext);
  if (!client) {
    throw new Error("useAcprouterOrpc must be used within an AcprouterOrpcProvider");
  }
  return client;
}
