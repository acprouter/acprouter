import "server-only";

/**
 * Plain REST, not oRPC — `acprouter-cli` is not a browser client, and
 * keeping its HTTP surface to one `fetch()` call matters for a package
 * launched via `npx` on every enrollment (spec §6.1's cold-start reasoning
 * for keeping the CLI a focused package). Public surface lives at `/api/v1`,
 * mirroring the convention `apps/busabase` already uses.
 */
import { RedeemEnrollmentTokenInputSchema } from "@acprouter/contract";
import {
  RedeemEnrollmentTokenError,
  redeemEnrollmentToken,
  runWithLocalContext,
} from "@acprouter/core";
import { getDb } from "~/db";

// `runWithLocalContext` sets nothing for the OSS edition — see its own doc
// comment. Wrapping here is a no-op today; it matches `apps/busabase`'s own
// route-handler convention ahead of a hosted host wrapping its equivalent
// route in `runWithMemberContext` instead.
export async function POST(request: Request) {
  return runWithLocalContext(() => handlePost(request));
}

async function handlePost(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = RedeemEnrollmentTokenInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_token", message: "Malformed redeem request." },
      { status: 400 },
    );
  }

  const db = await getDb();

  try {
    const result = await redeemEnrollmentToken(db, parsed.data);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof RedeemEnrollmentTokenError) {
      return Response.json({ error: error.code, message: error.message }, { status: 400 });
    }
    throw error;
  }
}
