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
