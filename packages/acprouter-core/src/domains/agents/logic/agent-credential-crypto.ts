import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Encryption-at-rest for `acprouter_agent_credentials.encryptedPayload`
 * (spec §7: "own table, own encryption-at-rest — not the user-facing vault,
 * different threat model, same reasoning Busabase's `cloud-connect-store.ts`
 * already applies").
 *
 * That citation turned out to be wrong when checked against the actual file
 * (task #13's own finding, not assumed): `apps/busabase/src/domains/settings
 * /logic/cloud-connect-store.ts` stores `credentialToken`/`credentialRefreshToken`
 * as plain `text()` columns in `apps/busabase/src/domains/settings/schema/
 * cloud-connect.ts` — there is no encryption there at all, so "the same
 * reasoning" spec §7 points at doesn't actually exist in code. A Buda
 * `sk_...` API key is exactly the kind of secret this table's own doc
 * comment says it must protect, so this module instead mirrors the pattern
 * that IS real in this codebase for "own table, real encryption, no
 * plaintext fallback": `packages/busabase-core/src/domains/webhook/logic/
 * webhook-crypto.ts` (AES-256-GCM via `createCipheriv`/`createDecipheriv`/
 * `randomBytes`, and — unlike that file's sibling `vault-crypto.ts` — no
 * "store it plaintext if no key is configured" escape hatch). See this
 * task's changelog "Why" section for the full paper trail.
 *
 * One deliberate difference from `webhook-crypto.ts`: that file resolves its
 * key from a chain of THIS app's own existing secrets (`BUSABASE_VAULT_
 * ENCRYPTION_KEY` / `BUSABASE_ENV_ENCRYPTION_KEY` / `BETTER_AUTH_SECRET`) —
 * `apps/acprouter` has no such chain to reuse: the OSS edition ships with no
 * authentication or accounts at all (spec §8.1), so there is no
 * `BETTER_AUTH_SECRET`-shaped app secret already sitting in this app's env.
 * Inventing a fallback chain that references secrets this app doesn't have
 * would be worse than requiring the one dedicated var explicitly.
 */
function readEncryptionKey(): Buffer {
  const raw = process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "Set ACPROUTER_CREDENTIAL_ENCRYPTION_KEY before connecting a remote-acp agent " +
        "(e.g. Buda) — a 32-byte key, hex or base64 encoded. There is no fallback env " +
        "var in this app: the OSS edition ships with no login/accounts (spec §8.1), so " +
        "there is no existing app secret to reuse the way webhook-crypto.ts does.",
    );
  }
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (/^[A-Za-z0-9+/=]{44}$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  }
  // Same graceful-degrade-to-a-derived-key behavior as webhook-crypto.ts —
  // an operator's arbitrary passphrase still yields a valid 32-byte AES key
  // rather than a hard failure over key-length pedantry.
  return createHash("sha256").update(raw).digest();
}

interface AgentCredentialPayload {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Returns a single JSON string, not an object — `acprouter_agent_credentials
 * .encryptedPayload` is one `text` column (`schema/agent-credentials.ts`),
 * unlike webhook secrets, which embed the equivalent object straight into a
 * jsonb column. Serializing here is what makes this fit that one column
 * without a schema change.
 */
export function encryptAgentApiKey(value: string): string {
  const key = readEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  const payload: AgentCredentialPayload = {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(payload);
}

export function decryptAgentApiKey(serialized: string): string {
  const payload = JSON.parse(serialized) as AgentCredentialPayload;
  if (payload.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported agent credential encryption payload: "${payload.algorithm}"`);
  }
  const key = readEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  // A tampered ciphertext or tag fails `decipher.final()`'s GCM auth check
  // and throws — there is no path that returns corrupted plaintext silently.
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
