import { readFileSync } from "node:fs";

import type { DoctorFinding, DoctorInput } from "./doctor-types.ts";

import { scopeList } from "../core/scopes.ts";
import { tableKey } from "./deciding-columns.ts";
import { policyOf } from "./doctor-collect.ts";
import { MIGRATION_DIRS } from "./doctor-project.ts";
import { sqlFiles } from "./files.ts";
import { guardedTables, ownershipRules } from "./rls-ownership.ts";
import { partPath } from "./sql-files.ts";
import { group, sqlStatements } from "./sql-statements.ts";

const TRIGGER = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?trigger\s+"?permdock_assignment"?\s[\s\S]*?\bon\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`,
  "iu",
);

/** The tables a `permdock_assignment` trigger is created on in the migrations and the `rls generate` output. */
function triggeredTables(input: DoctorInput): ReadonlySet<string> {
  const out = input.config.rls?.out ?? "rls.sql";
  const files = sqlFiles(input.cwd, [
    ...(input.config.doctor?.migrations ?? MIGRATION_DIRS),
    ...new Set(
      [out, partPath(out, "helpers"), partPath(out, "policies")].filter(
        (file) => file.endsWith(".sql"),
      ),
    ),
  ]);
  const tables = new Set<string>();
  for (const file of files) {
    for (const statement of sqlStatements(readFileSync(file, "utf8"))) {
      const match = TRIGGER.exec(statement.text);
      if (match !== null) {
        tables.add(tableKey(group(match, 1)));
      }
    }
  }
  return tables;
}

/**
 * PD064: `rls.assignments` guards a table (a membership table, the
 * global-roles table or a listed table) that no `permdock_assignment`
 * trigger is created on in the migrations or the `rls generate` output, so a
 * client may write any role there.
 */
export async function pd064(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.rls?.assignments === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  if ((ownershipRules(policy, scopes)?.assigns.length ?? 0) === 0) {
    return [];
  }
  const found = triggeredTables(input);
  return guardedTables(input.config, scopes)
    .filter((table) => !found.has(tableKey(table)))
    .map((table) => ({
      code: "PD064",
      severity: "warning" as const,
      message: `rls.assignments guards ${table}, but no migration creates its permdock_assignment trigger, so a client may write any role there`,
      fix: "run permdock rls generate and apply its output in a migration, or set rls.out or doctor.migrations to where it lives",
    }));
}
