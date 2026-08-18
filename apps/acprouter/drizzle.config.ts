import { defineConfig } from "drizzle-kit";
import { parseDrizzleDbConfig } from "openlib/db";

const { dbCredentials, ...driverConfig } = parseDrizzleDbConfig(
  process.env.PG_DATABASE_URL ?? "pglite://.data/acprouter",
);

export default defineConfig({
  schema: "../../packages/acprouter-core/src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  ...driverConfig,
  dbCredentials,
});
