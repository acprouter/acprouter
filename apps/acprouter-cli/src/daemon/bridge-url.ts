/**
 * Rewrites a Router's HTTP(S) origin (what the user passed to `--server`,
 * and what's persisted in device config) into the bridge WS(S) URL — never
 * hardcode `ws://`: a self-hosted Router behind TLS (spec §6's OSS notes:
 * "a WebSocket-safe ingress ... is the most common thing to get wrong behind
 * a proxy") is `https://`, and this must become `wss://`, not `ws://`.
 */
export function toBridgeWebSocketUrl(server: string, machineId: string): string {
  const url = new URL("/api/machines/bridge", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("machineId", machineId);
  return url.toString();
}

/**
 * The bridge credential (task #6.4) is sent ONLY as an `Authorization`
 * header on the WS upgrade request, never as a query parameter — the Router
 * side (`machine-bridge-connection.ts`'s `PresentedBridgeCredential`) rejects
 * a credential found on the query string outright rather than honoring it,
 * and query strings routinely end up in proxy/server access logs in a way
 * headers don't. `undefined` for `legacy` machines with no credential at
 * all, producing no `Authorization` header on the request.
 */
export function toBridgeWebSocketHeaders(
  bridgeCredential: string | undefined,
): Record<string, string> | undefined {
  if (!bridgeCredential) return undefined;
  return { Authorization: `Bearer ${bridgeCredential}` };
}
