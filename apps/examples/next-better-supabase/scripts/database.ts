import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = path.join(import.meta.dirname, "..");

export type Database = {
  readonly url: string;
  readonly statements: boolean;
  readonly stop: () => Promise<void>;
};

/**
 * The auth stub, then every migration in name order, then the seed: what
 * `supabase db reset` applies.
 */
function setupSql(): string {
  const migrations = path.join(root, "supabase/migrations");
  const files = readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  return [
    readFileSync(path.join(root, "scripts/auth-stub.sql"), "utf8"),
    ...files.map((name) => readFileSync(path.join(migrations, name), "utf8")),
    readFileSync(path.join(root, "supabase/seed.sql"), "utf8"),
  ].join("\n;\n");
}

/**
 * A throwaway Postgres 17 with the app's migrations and seed applied.
 * `statements` preloads `pg_stat_statements`. The measurement build asks for
 * it; a normal `serve` does not, so the container command stays the image
 * default.
 */
export async function startDatabase(options?: {
  readonly statements?: boolean;
}): Promise<Database> {
  const statements = options?.statements === true;
  const started = new PostgreSqlContainer("postgres:17-alpine");
  const container = await (
    statements
      ? started.withCommand([
          "postgres",
          "-c",
          "shared_preload_libraries=pg_stat_statements",
          "-c",
          "pg_stat_statements.track=all",
        ])
      : started
  ).start();
  const url = container.getConnectionUri();
  const client = new Client({ connectionString: url });
  await client.connect();
  let statementsReady = false;
  try {
    if (statements) {
      try {
        await client.query("create extension if not exists pg_stat_statements");
        statementsReady = true;
      } catch {
        // The image has no extension. Callers record statement counts as not measured.
      }
    }
    await client.query(setupSql());
  } finally {
    await client.end();
  }
  return {
    url,
    statements: statementsReady,
    stop: async () => {
      await container.stop();
    },
  };
}
