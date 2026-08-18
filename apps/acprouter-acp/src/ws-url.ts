/**
 * Rewrites the Router's HTTP(S) origin (`--server`/`ACPROUTER_SERVER`) into
 * the consumer ACP WebSocket URL spec §5.3 point 1 defines —
 * `wss://<router>/api/acp?agentId=<id>` — the same shape
 * `apps/acprouter-cli/src/daemon/bridge-url.ts#toBridgeWebSocketUrl` builds
 * for the OTHER leg of this Router (never hardcode `ws://`: a self-hosted
 * Router behind TLS is `https://`, and this must become `wss://`).
 */
export function toConsumerAcpWebSocketUrl(server: string, agentId: string): string {
  const url = new URL("/api/acp", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agentId", agentId);
  return url.toString();
}
