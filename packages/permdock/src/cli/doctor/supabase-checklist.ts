import { join } from "node:path";

import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";

import { parseSqlLenient, readPolicy } from "../sql/ast.ts";

const SQL_ROOTS = ["supabase/schemas", "supabase/migrations"] as const;

function sqlTexts(cwd: string, files: DoctorFiles): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of files.list(dir)) {
      const path = join(dir, name);
      if (files.isDirectory(path)) {
        walk(path);
      } else if (name.endsWith(".sql")) {
        found.push(files.read(path));
      }
    }
  };
  for (const root of SQL_ROOTS) {
    const absolute = join(cwd, root);
    if (files.isDirectory(absolute)) {
      walk(absolute);
    }
  }
  return found;
}

/**
 * PD099: an `update` policy on a table with no `select` policy. Postgres reads
 * the row before it updates it, so the update matches nothing and returns zero
 * rows without an error.
 */
export async function pd099(
  cwd: string,
  files: DoctorFiles,
): Promise<readonly DoctorFinding[]> {
  const commands = new Map<string, Set<string>>();
  for (const text of sqlTexts(cwd, files)) {
    for (const statement of await parseSqlLenient(text)) {
      const policy = readPolicy(statement);
      if (policy === undefined) {
        continue;
      }
      const table = `${policy.schema}.${policy.table}`.toLowerCase();
      const set = commands.get(table) ?? new Set<string>();
      set.add(policy.command);
      commands.set(table, set);
    }
  }
  return [...commands]
    .filter(
      ([, set]) => set.has("update") && !set.has("select") && !set.has("all"),
    )
    .map(([table]) => ({
      code: "PD099",
      severity: "warning" as const,
      target: table,
      message: `${table} has an update policy and no select policy, so an update matches no rows and returns none`,
      fix: "add a select policy on the table; permdock generate writes one beside every write policy",
    }));
}

/**
 * PD098: a database URL on Supabase's transaction pooler (port 6543). The
 * generated helpers are called as prepared statements, which the transaction
 * pooler does not keep between statements.
 */
export function pd098(
  env: Readonly<Record<string, string | undefined>>,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const name of ["DATABASE_URL", "SUPABASE_DB_URL"] as const) {
    const value = env[name];
    if (value === undefined || value === "") {
      continue;
    }
    let port = "";
    try {
      port = new URL(value).port;
    } catch {
      continue;
    }
    if (port === "6543") {
      findings.push({
        code: "PD098",
        severity: "warning",
        target: name,
        message: `${name} uses port 6543, the transaction pooler, which does not keep prepared statements`,
        fix: "use the session pooler (port 5432), or set prepare: false on the driver",
      });
    }
  }
  return findings;
}
