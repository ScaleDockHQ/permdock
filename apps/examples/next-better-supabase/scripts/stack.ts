import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";

const Status = z.object({
  env: z.object({
    API_URL: z.string(),
    DB_URL: z.string(),
    PUBLISHABLE_KEY: z.string(),
  }),
});

export type Stack = {
  readonly apiUrl: string;
  readonly databaseUrl: string;
  readonly publishableKey: string;
};

const supabase = path.join(
  import.meta.dirname,
  "../node_modules/.bin/supabase",
);

/** The local stack from `supabase status`. Ports are chosen per worktree. */
export function stackStatus(): Stack {
  const status: unknown = JSON.parse(
    execFileSync(supabase, ["status", "--output-format", "json"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf8",
    }),
  );
  const parsed = Status.parse(status);
  return {
    apiUrl: parsed.env.API_URL,
    databaseUrl: parsed.env.DB_URL,
    publishableKey: parsed.env.PUBLISHABLE_KEY,
  };
}

/** The local stack's database URL. Start it with `pnpm supabase:start`. */
export function stackDbUrl(): string {
  return stackStatus().databaseUrl;
}

/** Whether this database loaded `pg_stat_statements`. */
export async function statementsEnabled(databaseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      "select 1 from pg_extension where extname = 'pg_stat_statements'",
    );
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}
