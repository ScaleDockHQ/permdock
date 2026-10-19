import type { CommandResult } from "../core/result.ts";
import type { RlsFixture } from "../fixtures.ts";
import type { SqlConnect } from "../pg.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { policyRowConditionKeys } from "../../core/row-conditions.ts";
import { type Scope, scopeList } from "../../core/scopes.ts";
import { type CustomRole, type Policy, findPermission } from "../../index.ts";
import { describeError } from "../core/errors.ts";
import {
  HELPER_TABLE_POLICIES_SQL,
  helperTablePoliciesFromRows,
  rowConditionMessage,
} from "../sql/helper-calls.ts";
import { quoteIdent, quoteTable } from "../sql/quote.ts";
import { FIELD_VIEWS, viewName } from "./fields.ts";
import {
  type InProcess,
  type Subject,
  customRoleRows,
  customRoleSchema,
  rowId,
  seedsCustomRoleTables,
  statementFor,
  subjectOf,
  subjectSettings,
} from "./verify-pgtap.ts";
import { verifyTree } from "./verify-tree.ts";

/** Columns of `row` that hold a value; a masked column reads as null. */
function valuedColumns(row: unknown): readonly string[] {
  return isRecord(row)
    ? Object.keys(row)
        .filter((name) => row[name] !== null && row[name] !== undefined)
        .toSorted()
    : [];
}

/**
 * What a field view returns for a row: nothing for a denied row, otherwise
 * `pick`'s columns with a value plus the key, which always passes through.
 */
export function expectedFields(
  granted: boolean,
  picked: unknown,
  key: string,
  row: unknown,
): readonly string[] {
  if (!granted) {
    return [];
  }
  const kept = new Set(valuedColumns(picked));
  if (isRecord(row) && row[key] !== null && row[key] !== undefined) {
    kept.add(key);
  }
  return [...kept].toSorted();
}

function fieldsMismatch(
  fixture: RlsFixture,
  want: readonly string[],
  seen: readonly string[] | string,
): readonly string[] {
  const kept = want.join(", ");
  if (typeof seen === "string") {
    return [
      `${fixture.action}: field view read failed (${seen}), pick keeps [${kept}]`,
    ];
  }
  return seen.join(", ") === kept
    ? []
    : [
        `${fixture.action} ${String(rowId(fixture.row))}: field view returns [${seen.join(", ")}], pick keeps [${kept}]`,
      ];
}

/** The field view's columns for the fixture's row: the view, or the table itself when no grant limits its fields. */
async function viewFields(
  query: QueryFn,
  table: string,
  key: unknown,
): Promise<readonly string[] | string> {
  const view = quoteTable(viewName(table, FIELD_VIEWS.view));
  const id = quoteIdent("id");
  await query("savepoint permdock_fields");
  const result = await query(`select * from ${view} where ${id} = $1`, [key]);
  if (result.code === undefined) {
    return valuedColumns(result.rows[0]);
  }
  await query("rollback to savepoint permdock_fields");
  if (result.code !== "42P01") {
    return result.code;
  }
  const base = await query(
    `select * from ${quoteTable(table)} where ${id} = $1`,
    [key],
  );
  return base.code ?? valuedColumns(base.rows[0]);
}

type QueryFn = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly code?: string;
}>;

/** Writes the custom roles into the `database`-mode tables; the fixture transaction rolls them back. */
async function seedCustomRoles(
  query: QueryFn,
  schema: string,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): Promise<void> {
  for (const row of customRoleRows(schema, customRoles, scopes)) {
    const result = await query(row.sql, row.values);
    if (result.code !== undefined) {
      throw new Error(
        `PermDock CLI: rls verify --db-url could not seed custom roles (${result.code}); connect as a role that owns the custom_role_* tables`,
      );
    }
  }
}

async function bindSubject(
  query: QueryFn,
  fixture: RlsFixture,
  subject: Subject,
): Promise<void> {
  await query('set local role "authenticated"');
  for (const [name, value] of subjectSettings(fixture, subject)) {
    await query("select set_config($1, $2, true)", [name, value]);
  }
}

export async function verifyAgainstDatabase(input: {
  readonly db: string;
  readonly policy: Policy;
  readonly fixtures: readonly RlsFixture[];
  readonly customRoles: readonly CustomRole[];
  readonly config: PermDockConfig;
  readonly inProcess: readonly InProcess[];
  readonly connect: SqlConnect;
}): Promise<{ readonly mismatches: string[]; readonly notes: string[] }> {
  const client = await input.connect(input.db);
  const seedsTables = seedsCustomRoleTables(input.config);
  const schema = customRoleSchema(input.config);
  const scopes = scopeList(input.policy.scopes);
  const subject = subjectOf(input.config, input.customRoles, scopes);
  const query: QueryFn = async (sql, values) => {
    try {
      const result = await client.query(
        sql,
        values === undefined ? [] : [...values],
      );
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (cause) {
      const code =
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : undefined;
      return { rows: [], rowCount: 0, ...(code === undefined ? {} : { code }) };
    }
  };
  const mismatches: string[] = [];
  const notes: string[] = [];
  try {
    const conditioned = policyRowConditionKeys(input.policy);
    for (const found of helperTablePoliciesFromRows(
      (await query(HELPER_TABLE_POLICIES_SQL)).rows,
    )) {
      const keys = found.keys.filter((key) => conditioned.has(key));
      if (keys.length > 0) {
        mismatches.push(`PD037 ${rowConditionMessage(found, keys)}`);
      }
    }
    for (const [index, fixture] of input.fixtures.entries()) {
      const permission = findPermission(
        input.policy.permissions,
        fixture.action,
      );
      const status = input.inProcess[index];
      if (permission === undefined || status === undefined) {
        continue;
      }
      if (status.kind === "opaque") {
        notes.push(`${fixture.action}: opaque grant untestable app-side`);
        continue;
      }
      const table =
        input.config.rls?.tables?.[permission.resource] ?? permission.resource;
      await query("begin");
      try {
        if (seedsTables) {
          await seedCustomRoles(query, schema, input.customRoles, scopes);
        }
        await bindSubject(query, fixture, subject);
        const statement = statementFor(fixture, permission.action, table);
        const result = await query(statement.sql, statement.values);
        const count = result.rowCount ?? result.rows.length;
        const database =
          result.code === "42501"
            ? "rejected"
            : count > 0
              ? "allowed"
              : "filtered";
        const ok = status.granted
          ? database === "allowed"
          : database === "filtered" || database === "rejected";
        if (!ok) {
          mismatches.push(
            `${fixture.action}: in-process ${status.granted ? "granted" : "denied"}, database ${database}`,
          );
        } else if (status.kind === "sqlFunction") {
          notes.push(`${fixture.action}: verified through twin`);
        }
        mismatches.push(
          ...(status.fields === undefined
            ? []
            : fieldsMismatch(
                fixture,
                status.fields,
                await viewFields(query, table, rowId(fixture.row)),
              )),
        );
      } finally {
        await query("rollback");
      }
    }
  } finally {
    await client.end();
  }
  return { mismatches, notes };
}

/** `--tree`: seeds a generated object graph in a rolled-back transaction and compares `can()` with RLS. */
export async function verifyTreeAgainstDatabase(
  db: string,
  policy: Policy,
  config: PermDockConfig,
  connect: SqlConnect,
): Promise<CommandResult> {
  const client = await connect(db);
  const scopes = scopeList(policy.scopes);
  const query = async (
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> => {
    const result = await client.query(
      sql,
      values === undefined ? [] : [...values],
    );
    return { rows: result.rows };
  };
  const loose: QueryFn = async (sql, values) => {
    await query(sql, values);
    return { rows: [] };
  };
  try {
    await query("begin");
    const result = await verifyTree({
      policy,
      config,
      query,
      bind: (subject) =>
        bindSubject(
          loose,
          { subject: { id: subject }, row: {}, action: "read" },
          subjectOf(config, [], scopes),
        ),
    });
    if (result.mismatches.length > 0) {
      return {
        code: 1,
        output: [...result.mismatches, ...result.notes].join("\n"),
      };
    }
    const verified = `verified ${String(result.checked)} tree check(s) against the database (${String(result.granted)} granted)`;
    return {
      code: 0,
      output:
        result.notes.length === 0
          ? verified
          : `${verified}\n${result.notes.join("\n")}`,
    };
  } catch (cause) {
    const message = describeError(cause);
    return {
      code: 2,
      output: `PermDock CLI: rls verify --tree could not seed the tree (${message}); connect as a role that owns the tables and is a member of authenticated`,
    };
  } finally {
    await client.query("rollback", []).catch(() => undefined);
    await client.end();
  }
}
