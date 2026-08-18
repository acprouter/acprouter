/**
 * Spec §8.1 point 3: "the app says so itself." OSS ships with no login, so
 * the one honest defense left is the dashboard naming the exposure out loud
 * when it looks like it's reachable from outside localhost with no operator
 * front door in place.
 *
 * There is no reliable way to ask "what interface is this HTTP server bound
 * to" from inside a Next.js route/layout handler — `next start -H
 * 127.0.0.1` configures the underlying `http.Server`, which per-request
 * handler code never sees. The only per-request signal available is the
 * `Host` header the connecting browser actually dialed (falling back to
 * `X-Forwarded-Host`, which a reverse proxy may rewrite `Host` behind). That
 * is an honest-effort heuristic for THIS banner's own honest-effort purpose
 * (operator awareness), not a security boundary — it doesn't need to be
 * spoof-proof, because the only thing spoofing it changes is whether a
 * request that already reached this instance gets warned about the exposure
 * it's already exploiting.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameOf(hostHeader: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(hostHeader); // IPv6 "[::1]:port"
  if (bracketed) return bracketed[1]?.toLowerCase() ?? "";
  // A real Host header never sends an unbracketed IPv6 literal (RFC 3986
  // requires brackets precisely so ":" can't collide with the port
  // separator), but handling it here too costs nothing and keeps this
  // function correct against a hand-built header, not just a browser's.
  if (hostHeader.toLowerCase() === "::1") return "::1";
  return (hostHeader.split(":")[0] ?? hostHeader).toLowerCase();
}

/**
 * Missing `Host` header defaults to "loopback" (don't warn) rather than "not
 * loopback" (warn) — every real HTTP request Next.js hands a route/layout
 * carries one, so this branch only exists to fail toward silence instead of
 * a false alarm in some unanticipated caller shape, matching this banner's
 * hard requirement to never misfire for ordinary local dev.
 */
export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return true;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader));
}

function isTrustReverseProxyEnabled(envValue: string | undefined): boolean {
  return envValue === "true";
}

export interface ExposureBannerInput {
  hostHeader: string | null | undefined;
  forwardedHostHeader?: string | null | undefined;
  /** Raw `process.env.ACPROUTER_TRUST_REVERSE_PROXY` — pass-through so this stays a pure function. */
  trustReverseProxyEnv: string | undefined;
}

/**
 * `X-Forwarded-Host` wins when present: a reverse proxy sitting in front
 * commonly rewrites `Host` to its own upstream target, so the header a proxy
 * sets to record the ORIGINAL request is the more honest "what did the
 * browser actually dial" signal in that case. Plain `Host` covers the no-proxy
 * case, which is also the common local-dev case this must never flag.
 */
export function shouldShowExposureBanner(input: ExposureBannerInput): boolean {
  if (isTrustReverseProxyEnabled(input.trustReverseProxyEnv)) return false;
  const effectiveHost = input.forwardedHostHeader || input.hostHeader;
  return !isLoopbackHost(effectiveHost);
}
