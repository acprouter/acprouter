import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "./db";

/**
 * No `actor` — the OSS edition ships with no authentication or accounts,
 * by design (spec §8.1). Every `machines.*` row is scoped to a single fixed
 * owner until the hosted edition adds real multi-tenant accounts.
 */
export interface Context {
  db: Database;
  /** Computed from the inbound request at the transport boundary — what the
   *  enrollment command's `--server` value should point back at. */
  serverOrigin: string;
}

/** The OSS edition's single owner — see `Context`'s docstring, and
 *  `AcprouterContext` below for how a hosted multi-tenant edition overrides
 *  it without touching any of the `domains/agents/logic/` call sites that
 *  reference it as a query predicate today. */
export const LOCAL_OWNER_ID = "local";

/**
 * Ambient, request-scoped override for the OSS single-owner defaults above —
 * the same `AsyncLocalStorage` seam `packages/busabase-core/src/context.ts`
 * (read that file's own doc comment first) uses to let a hosted multi-tenant
 * edition reuse OSS logic unmodified instead of rewriting every function
 * signature. This is the deliberately LEANER version of that idea:
 *
 * - `ownerId` is the field doing new work here. Every direct `LOCAL_OWNER_ID`
 *   reference in `domains/agents/logic/` becomes a call to `resolveOwnerId()`,
 *   so a hosted host can scope the exact same queries to a real tenant id by
 *   running its request inside `runWithMemberContext` — zero signature
 *   changes to any logic function.
 * - `db` exists for the same "one DB, one migration story" reason
 *   busabase-core's own `BusabaseContext.db` doc comment gives: a hosted host
 *   should not run a second, separate Postgres/PGLite instance just for
 *   `acprouter_*` tables when it already has its own drizzle client for
 *   everything else. Unlike busabase-core, that reasoning does NOT require
 *   touching the logic layer at all here: every `domains/agents/logic/`
 *   function already takes `db` as an explicit first parameter (this repo's
 *   own DDD convention: logic functions take `db` as their first param),
 *   so there is no scattered internal singleton read inside logic
 *   to intercept the way busabase-core's `db` proxy does. The ONE place a
 *   `db` override matters is `db/index.ts`'s `getDb()` — the function every
 *   route handler calls to obtain the instance it then passes explicitly
 *   into logic — which checks `getContextDb()` first and falls back to its
 *   existing singleton otherwise.
 *
 * Deliberately NOT modeled on busabase-core's `BusabaseContext`: no ACL
 * booleans, no visitor-kind, no demo mode — ACP Router OSS has no permission
 * model at all (spec §8.1: single owner, full access), and the hosted
 * edition's real authorization model is separate, later work (task #19).
 * Porting those fields now would be solving a problem this codebase doesn't
 * have yet.
 */
export interface AcprouterContext {
  db?: Database;
  ownerId?: string;
}

const storage = new AsyncLocalStorage<AcprouterContext>();

/**
 * Run `fn` as the OSS single-owner host. Sets nothing, by design: the OSS
 * edition has no auth or tenant to resolve, so every getter's absent-value
 * default (`LOCAL_OWNER_ID`, the local singleton `getDb()`) already IS the
 * intended behavior — busabase-core's own `runWithLocalContext` doc comment
 * calls naming this kind (rather than a caller hand-assembling an empty
 * context inline) turning "a transport forgot to pick a kind" into "a
 * transport explicitly chose local"; the same reasoning applies verbatim.
 */
export function runWithLocalContext<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({}, fn);
}

/**
 * Run `fn` as a real authenticated tenant — a hosted host (not wired up by
 * this task, which only prepares this seam). Both fields are
 * required together: an injected `db` with no `ownerId` would silently scope
 * queries to `LOCAL_OWNER_ID` inside someone else's database, and an
 * `ownerId` with no `db` would still write into the OSS singleton — either
 * is a worse failure than a compile error.
 */
export function runWithMemberContext<T>(
  ctx: Required<AcprouterContext>,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** The injected host db for the current request, or `undefined` in OSS/local mode. */
export function getContextDb(): Database | undefined {
  return storage.getStore()?.db;
}

/**
 * Resolves the owner id every `domains/agents/logic/` query predicate scopes
 * to: the host-injected tenant id when running inside `runWithMemberContext`,
 * otherwise the OSS single-owner sentinel. Unlike busabase-core's
 * `resolveActorId(inputActorId)`, this takes no fallback parameter — no call
 * site ever had its own caller-supplied owner id to begin with (they all
 * referenced the `LOCAL_OWNER_ID` constant directly), so there is nothing to
 * fall back to besides that same constant.
 */
export function resolveOwnerId(): string {
  return storage.getStore()?.ownerId ?? LOCAL_OWNER_ID;
}
