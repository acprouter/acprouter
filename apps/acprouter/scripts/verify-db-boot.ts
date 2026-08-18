/**
 * Verifies the migration in `src/db/migrations` actually boots against a
 * real (throwaway) PGLite instance — not just that `drizzle-kit generate`
 * produced SQL. Run manually; not part of `pnpm dev` (that would mean the
 * embedded PGLite path always re-runs migrations on every dev boot, which
 * `busabase`'s own db client already does deliberately — this script exists
 * so the check can also run in a scratch dir standalone).
 */
import { rmSync } from "node:fs";
import { getDb, schema } from "@acprouter/core/db";
import { getTableName, sql } from "drizzle-orm";

const SCRATCH_DIR = ".data/verify-db-boot";

async function main() {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;

  const db = await getDb();

  const tables = [
    schema.acprouterMachines,
    schema.acprouterEnrollmentTokens,
    schema.acprouterAgents,
    schema.acprouterAgentCredentials,
    schema.acprouterAgentSessions,
    schema.acprouterAgentSessionEvents,
    schema.acprouterUsageRecords,
  ];

  for (const table of tables) {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(table);
    console.log(`ok: ${getTableName(table)} (${rows[0].count} rows)`);
  }

  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  console.log("PASS: migration boots and all 7 tables are queryable");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL:", error);
  process.exit(1);
});
