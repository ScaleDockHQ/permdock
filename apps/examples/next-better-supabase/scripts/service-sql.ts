import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const FILES = ["realtime/permdock.sql", "storage/permdock.sql"] as const;

/**
 * Current Realtime and Storage policies. A scoped sync does not load
 * `supabase/service`, and the copies inside old seeds migrations call a helper
 * that did not exist yet when they were written.
 */
export async function applyServiceSql(databaseUrl: string): Promise<void> {
  const root = path.join(import.meta.dirname, "../supabase/service");
  const sql = FILES.map((file) =>
    readFileSync(path.join(root, file), "utf8"),
  ).join("\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
