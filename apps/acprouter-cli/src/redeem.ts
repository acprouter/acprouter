import os from "node:os";

export interface RedeemSuccess {
  machineId: string;
  intendedAgentSlug: string | null;
}

export class RedeemError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * POSTs to the Router's `/api/v1/machines/redeem` — plain REST, not oRPC
 * (spec §5.3): the CLI is not a browser client, and this keeps its HTTP
 * surface to one `fetch()` call.
 */
export async function redeemEnrollmentToken(
  server: string,
  token: string,
  label: string | undefined,
  cliVersion: string,
): Promise<RedeemSuccess> {
  const url = new URL("/api/v1/machines/redeem", server);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        label,
        platform: `${os.platform()} ${os.release()}`,
        cliVersion,
      }),
    });
  } catch (error) {
    throw new RedeemError(
      "network_error",
      `Could not reach ${server}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "unknown_error";
    const message =
      typeof body?.message === "string" ? body.message : `Redeem failed (HTTP ${response.status}).`;
    throw new RedeemError(code, message);
  }

  if (typeof body?.machineId !== "string") {
    throw new RedeemError("invalid_response", "Router returned an unexpected response to redeem.");
  }
  const intendedAgentSlug =
    typeof body?.intendedAgentSlug === "string" ? body.intendedAgentSlug : null;
  return { machineId: body.machineId, intendedAgentSlug };
}
