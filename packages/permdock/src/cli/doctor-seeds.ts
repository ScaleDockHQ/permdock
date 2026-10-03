import { readFileSync } from "node:fs";

import type { DoctorFinding } from "./doctor-types.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type { PermDockConfig } from "./types.ts";

import { scopeList } from "../core/scopes.ts";
import { supabaseTenantClaim } from "../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { tableKey } from "./deciding-columns.ts";
import { loadPolicy } from "./doctor-collect.ts";
import { MIGRATION_DIRS } from "./doctor-project.ts";
import { rel, sqlFiles } from "./files.ts";
import { compileGrants } from "./rls-compile.ts";
import { group, sqlStatements } from "./sql-statements.ts";

const SEED_INSERT =
  /^insert\s+into\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*\(\s*role\s*,\s*permission\s*,\s*grant_key\s*,\s*scope\s*,\s*effect\s*\)\s*values\s*([\s\S]*?)\s*on\s+conflict\b/iu;
const SEED_CLEAR =
  /^delete\s+from\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*$/iu;
const LITERAL = String.raw`'((?:[^']|'')*)'`;
const SEED_ROW = new RegExp(
  String.raw`\(\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*\)`,
  "gu",
);

type Seeded = {
  readonly file: string;
  readonly rows: ReadonlySet<string>;
};

function rowKey(values: readonly string[]): string {
  return values.join(" ");
}

/** The rows of the last statement that seeds or clears `table`, in migration order. */
function lastSeed(
  cwd: string,
  config: PermDockConfig,
  table: string,
): Seeded | undefined {
  let seeded: Seeded | undefined;
  for (const file of sqlFiles(
    cwd,
    config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    for (const { text } of sqlStatements(readFileSync(file, "utf8"))) {
      const insert = SEED_INSERT.exec(text);
      if (insert !== null && tableKey(group(insert, 1)) === table) {
        const rows = new Set<string>();
        for (const row of group(insert, 2).matchAll(SEED_ROW)) {
          rows.add(
            rowKey(row.slice(1, 6).map((value) => value.replaceAll("''", "'"))),
          );
        }
        seeded = { file: rel(cwd, file), rows };
        continue;
      }
      const clear = SEED_CLEAR.exec(text);
      if (clear !== null && tableKey(group(clear, 1)) === table) {
        seeded = { file: rel(cwd, file), rows: new Set() };
      }
    }
  }
  return seeded;
}

/** The first three rows, as `(role permission grant_key scope effect)`. */
function sample(rows: readonly string[]): string {
  return rows
    .slice(0, 3)
    .map((row) => `(${row})`)
    .join(", ");
}

/**
 * PD054: the `role_permissions` rows the migrations seed last are not the
 * rows the policy compiles to, so the helpers answer from a stale policy.
 */
export async function pd054(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const { cwd, config } = input;
  const rls = config.rls;
  if (
    config.policy === undefined ||
    (rls === undefined && config.supabase === undefined)
  ) {
    return [];
  }
  const schema = rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const seeded = lastSeed(cwd, config, `${schema}.role_permissions`);
  if (seeded === undefined) {
    return [];
  }
  const policy = await loadPolicy(cwd, config.policy);
  if (policy === undefined) {
    return [];
  }
  const ctx: RlsSqlContext = {
    dialect: rls?.dialect ?? "supabase",
    scopes: scopeList(policy.scopes),
    tenantClaim: rls?.tenantClaim ?? supabaseTenantClaim,
    gucPrefix: rls?.gucPrefix ?? "app",
    schema,
    ...(rls?.fields === "views" ? { fields: "views" as const } : {}),
  };
  let expected: ReadonlySet<string>;
  try {
    expected = new Set(
      compileGrants(policy, ctx, rls?.tables, [], true).rolePermissions.map(
        (row) =>
          rowKey([
            row.role,
            row.permission,
            row.grantKey,
            row.scope,
            row.effect,
          ]),
      ),
    );
  } catch {
    return [];
  }
  const missing = [...expected].filter((row) => !seeded.rows.has(row));
  const stale = [...seeded.rows].filter((row) => !expected.has(row));
  if (missing.length === 0 && stale.length === 0) {
    return [];
  }
  const parts = [
    ...(missing.length === 0
      ? []
      : [`${String(missing.length)} missing, such as ${sample(missing)}`]),
    ...(stale.length === 0
      ? []
      : [`${String(stale.length)} stale, such as ${sample(stale)}`]),
  ];
  return [
    {
      code: "PD054",
      severity: "warning",
      message: `${seeded.file} seeds ${schema}.role_permissions with rows the policy no longer compiles to: ${parts.join("; ")}`,
      fix: "run permdock rls generate (with --split ...,seeds --seeds-out into a new migration for declarative schemas) and apply it",
    },
  ];
}
