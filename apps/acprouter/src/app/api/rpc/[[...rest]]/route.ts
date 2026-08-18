import "server-only";

/**
 * Internal oRPC RPC endpoint for the dashboard. No auth middleware — the OSS
 * edition ships with no login (spec §8.1); the deployment's own front door
 * (reverse proxy, private network) is the boundary, not this route.
 */

import { agentsRouter, runWithLocalContext } from "@acprouter/core";
import { RPCHandler } from "@orpc/server/fetch";
import { getDb } from "~/db";

const handler = new RPCHandler({ agents: agentsRouter });

// `runWithLocalContext` sets nothing for the OSS edition (see its own doc
// comment) — wrapping here is a no-op today, and exists so this route
// matches `apps/busabase`'s own `runWithLocalContext` call-site convention
// ahead of a hosted host later wrapping its equivalent route in
// `runWithMemberContext` instead.
async function handle(request: Request) {
  return runWithLocalContext(() => handleWithContext(request));
}

async function handleWithContext(request: Request) {
  const db = await getDb();
  const serverOrigin = new URL(request.url).origin;

  const result = await handler.handle(request, {
    context: { db, serverOrigin },
    prefix: "/api/rpc",
  });

  if (!result.matched) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return result.response;
}

export const GET = handle;
export const POST = handle;
