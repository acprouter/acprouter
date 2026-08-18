import "server-only";

import { headers } from "next/headers";
import { shouldShowExposureBanner } from "~/lib/exposure-banner";

/**
 * Spec §8.1 point 3 — persistent, not a dismissible toast: a toast that goes
 * away trains people to stop reading it, which defeats the one honest
 * warning the OSS no-login edition gets to make. Server component so it can
 * read the real request `Host`/`X-Forwarded-Host` per §8.1's own heuristic
 * (`~/lib/exposure-banner.ts`) — no client-side re-detection to keep in sync.
 */
export async function ExposureBanner() {
  const headerList = await headers();
  const visible = shouldShowExposureBanner({
    hostHeader: headerList.get("host"),
    forwardedHostHeader: headerList.get("x-forwarded-host"),
    trustReverseProxyEnv: process.env.ACPROUTER_TRUST_REVERSE_PROXY,
  });
  if (!visible) return null;

  return (
    <div className="border-b border-status-warning/50 bg-status-warning/10 px-4 py-2 text-sm text-foreground">
      This Router is reachable from outside localhost with no login and no reverse-proxy protection
      configured — anyone who can reach it can enrol machines and drive connected agents. Put a
      reverse proxy with real auth (or a private network) in front of it, then set{" "}
      <code className="rounded bg-status-warning/20 px-1 py-0.5 font-mono text-xs">
        ACPROUTER_TRUST_REVERSE_PROXY=true
      </code>{" "}
      to dismiss this banner.
    </div>
  );
}
