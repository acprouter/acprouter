import "server-only";

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { isPgliteUrl, parsePgliteDataDir } from "openlib/db";
import postgres from "postgres";
import { getContextDb } from "../context";
import * as schema from "./schema";

type PgDb = ReturnType<typeof drizzlePg<typeof schema>>;
type PgliteDb = ReturnType<typeof drizzlePglite<typeof schema>>;
export type Database = PgDb | PgliteDb;

interface DbState {
  db: Database | null;
  initPromise: Promise<Database> | null;
}

// Stored on `globalThis`, not a module-level `const` — Next.js dev mode
// (Turbopack's on-demand, per-route lazy compilation) can re-evaluate a
// route handler's module graph independently per importer, which would
// otherwise silently mint a second db instance. Same reasoning as
// busabase-core's db client and busabase-cloud's tunnel relay hub.
type GlobalWithDbState = typeof globalThis & { __acprouterCoreDbState?: DbState };

function getDbState(): DbState {
  const g = globalThis as GlobalWithDbState;
  if (!g.__acprouterCoreDbState) {
    g.__acprouterCoreDbState = { db: null, initPromise: null };
  }
  return g.__acprouterCoreDbState;
}

function getDatabaseUrl(): string {
  return process.env.PG_DATABASE_URL ?? "pglite://.data/acprouter";
}

async function ensureLocalDir(dataDir: string) {
  if (dataDir && !dataDir.startsWith("memory://")) {
    await mkdir(dataDir, { recursive: true });
  }
}

async function initPglite(dataDir: string, migrationsFolder: string): Promise<Database> {
  await ensureLocalDir(dataDir);
  const { PGlite } = await import("@electric-sql/pglite");
  const client = await new PGlite(dataDir);
  const db = drizzlePglite({ client, schema });
  await migrate(db, { migrationsFolder });
  return db;
}

function initPostgres(url: string): Database {
  const client = postgres(url, { prepare: false });
  return drizzlePg({ client, schema });
}

/**
 * Resolves the shared db instance, initializing (and for PGLite, migrating)
 * on first call. `migrationsFolder` defaults to the caller's own
 * `src/db/migrations` — each app (OSS vs. hosted) generates its own
 * migrations against this same schema (spec §7.1: migrations are generated
 * twice, separately, once per app).
 *
 * Checks `getContextDb()` first, same as busabase-core's own `getDb()` — a
 * host running inside `runWithMemberContext` (a hosted multi-tenant edition,
 * not built by this task) gets its OWN injected drizzle client back instead
 * of this singleton, so `acprouter_*` tables can live in that host's shared
 * Postgres rather than a second, separate database. `apps/acprouter` (OSS)
 * never calls `runWithMemberContext`, so `getContextDb()` is always
 * `undefined` there and this falls through to the exact singleton behavior
 * below, unchanged.
 */
export function getDb(options: { migrationsFolder?: string } = {}): Promise<Database> {
  const contextDb = getContextDb();
  if (contextDb) return Promise.resolve(contextDb);

  const state = getDbState();
  if (state.db) return Promise.resolve(state.db);
  if (state.initPromise) return state.initPromise;

  const url = getDatabaseUrl();
  const migrationsFolder =
    options.migrationsFolder ?? path.resolve(process.cwd(), "src/db/migrations");

  state.initPromise = (async () => {
    const db = isPgliteUrl(url)
      ? await initPglite(parsePgliteDataDir(url), migrationsFolder)
      : initPostgres(url);
    state.db = db;
    return db;
  })();

  return state.initPromise;
}

export { schema };
