import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../../src/cli/run.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, "../fixtures/named-scopes.ts");
const SUPABASE = join(HERE, "../../src/supabase/index.ts");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

export function removeHookProjects(): void {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SOURCES = `fromTable({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at', managedBy: 'managed_by', seats: 'seats' } }),
    fromJunction({
      table: 'customer_contacts',
      scope: 'customer',
      within: { organization: 'organization_id' },
      roles: ['contact'],
      via: 'contact',
    }),`;

export async function generate(
  hook: string,
  extra: readonly string[] = [],
  rls = "{}",
): Promise<{ code: number; output: string; sql: string; cwd: string }> {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "supabase-hook-"));
  temps.push(cwd);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `import { fromJunction, fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: ${rls},
  supabase: { hook: ${hook} },
};
`,
  );
  const result = await run(
    ["supabase", "hook", "generate", "--out", "hook.sql", ...extra],
    { cwd },
  );
  let sql = "";
  try {
    sql = readFileSync(join(cwd, "hook.sql"), "utf8");
  } catch {
    sql = "";
  }
  return {
    code: result.code,
    output: result.stdout + result.stderr,
    sql,
    cwd,
  };
}
