import { spawnSync } from "node:child_process";
import path from "node:path";

import { startDatabase } from "./database.ts";

const cwd = path.join(import.meta.dirname, "..");
const bin = path.join(cwd, "node_modules/.bin/better-supabase");

/**
 * Runs `better-supabase <args>` against a fresh database with the migrations
 * applied, never against a local stack another project left running:
 * `gen` regenerates `src/lib/supabase/*`, `gen --check` fails on drift, `doctor` lints.
 */
const args = process.argv.slice(2);
const database = await startDatabase();
try {
  const result = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
    // 0.8 reads SUPABASE_DB_URL when DATABASE_URL is unset; a DATABASE_URL in the caller's shell must not win.
    env: { ...process.env, DATABASE_URL: "", SUPABASE_DB_URL: database.url },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await database.stop();
}
