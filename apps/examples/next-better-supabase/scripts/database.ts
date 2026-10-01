import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const root = path.join(import.meta.dirname, '..');

export type Database = {
  readonly url: string;
  readonly stop: () => Promise<void>;
};

/** The auth stub, then every migration in name order, then the seed: what `supabase db reset` applies. */
function setupSql(): string {
  const migrations = path.join(root, 'supabase/migrations');
  const files = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  return [
    readFileSync(path.join(root, 'scripts/auth-stub.sql'), 'utf8'),
    ...files.map((name) => readFileSync(path.join(migrations, name), 'utf8')),
    readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8'),
  ].join('\n;\n');
}

/** A throwaway Postgres 17 with the app's migrations and seed applied. */
export async function startDatabase(): Promise<Database> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(setupSql());
  } finally {
    await client.end();
  }
  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
