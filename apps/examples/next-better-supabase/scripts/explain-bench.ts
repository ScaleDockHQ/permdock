import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

import { startDatabase } from "./database.ts";

const root = path.join(import.meta.dirname, "..");
const benchDir = path.join(import.meta.dirname, "explain-bench");
const USER = "11111111-1111-4111-8111-111111111111";

/**
 * Plans `public.explain_ten_tables()` as a member of five organisations with
 * `better-supabase doctor --explain ... --as`, over the helpers the installed
 * `permdock` generates. Run it once per `permdock` build and compare the
 * printed doctor output. `--memo better-supabase` generates the helpers over
 * `better_supabase.memo_get/memo_set`.
 */
function generated(memo: string | undefined): string {
  const out = path.join(
    mkdtempSync(path.join(tmpdir(), "explain-bench-")),
    "bench.sql",
  );
  const config =
    memo === "better-supabase" ? ["--config", "better-supabase.config.ts"] : [];
  const result = spawnSync(
    path.join(root, "node_modules/.bin/permdock"),
    ["rls", "generate", "--target", "sql", "--out", out, ...config],
    { cwd: benchDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `permdock rls generate failed: ${result.stderr}${result.stdout}`,
    );
  }
  return readFileSync(out, "utf8");
}

const memoFlag = process.argv.indexOf("--memo");
const memo = memoFlag === -1 ? undefined : process.argv[memoFlag + 1];
const database = await startDatabase();
try {
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(
      readFileSync(path.join(import.meta.dirname, "explain-bench.sql"), "utf8"),
    );
    await client.query(generated(memo));
  } finally {
    await client.end();
  }
  const doctor = spawnSync(
    path.join(root, "node_modules/.bin/better-supabase"),
    ["doctor", "--explain", "public.explain_ten_tables", "--as", USER],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: "", SUPABASE_DB_URL: database.url },
    },
  );
  process.exitCode = doctor.status ?? 1;
} finally {
  await database.stop();
}
