import "server-only";

type PublicUrlEnvironment = Readonly<Record<string, string | undefined>>;

const PUBLIC_URL_ENV_KEYS = ["ACPROUTER_PUBLIC_URL", "NEXT_PUBLIC_APP_URL"] as const;

function readConfiguredPublicUrl(
  environment: PublicUrlEnvironment,
): { key: (typeof PUBLIC_URL_ENV_KEYS)[number]; value: string } | undefined {
  for (const key of PUBLIC_URL_ENV_KEYS) {
    const value = environment[key]?.trim();
    if (value) return { key, value };
  }
  return undefined;
}

/** Resolve the public origin embedded in CLI commands and WebSocket URLs. */
export function resolveServerOrigin(
  requestUrl: string,
  environment: PublicUrlEnvironment = process.env,
): string {
  const configured = readConfiguredPublicUrl(environment);
  if (!configured) return new URL(requestUrl).origin;

  let url: URL;
  try {
    url = new URL(configured.value);
  } catch {
    throw new Error(`${configured.key} must be an absolute HTTP(S) URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${configured.key} must use http:// or https://.`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${configured.key} must contain only an origin.`);
  }

  return url.origin;
}
