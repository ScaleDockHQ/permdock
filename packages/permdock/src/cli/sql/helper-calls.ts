import { deparse } from "pgsql-parser";

import { beforeFirst } from "../shared/text.ts";
import { SqlSyntaxError, parseSqlFile, readPolicy } from "./ast.ts";
import { HELPERS } from "./shared.ts";

/**
 * Tables whose policies other packages write by calling the SQL helpers
 * directly (storage buckets and realtime topics).
 */
export const HELPER_TABLES = ["storage.objects", "realtime.messages"] as const;

const HELPER_CALL = new RegExp(
  String.raw`\b(${HELPERS.has}(?:_permission)?|permitted_[a-z][a-z0-9_]*_ids(?:_by_permission)?)\s*\(\s*'((?:[^']|'')+)'(\s*,\s*(false\b)?)?`,
  "giu",
);

const ANY_HELPER = new RegExp(
  String.raw`\b(?:${HELPERS.has}(?:_permission)?(?:_for)?|permitted_[a-z][a-z0-9_]*_ids(?:_by_permission)?(?:_for)?|member_[a-z][a-z0-9_]*_ids(?:_for)?)\s*\(`,
  "iu",
);

/**
 * Whether a policy expression calls any generated helper, the key-less
 * `member_<scope>_ids` included.
 */
export function callsHelper(sql: string): boolean {
  return ANY_HELPER.test(sql);
}

/**
 * The permission keys a policy expression passes to `permdock_has`,
 * `permitted_<scope>_ids` or their permission-key forms, `#n` stripped. With
 * `blind`, only the calls that ignore row conditions: the grant-key forms, and
 * a permission-key form asked for conditioned allows. A plain
 * `permdock_has_permission(key)` or `permitted_<scope>_ids_by_permission(key)`
 * counts only allows without a row condition, so it never grants more than the
 * application does.
 */
export function helperCallKeys(sql: string, blind = false): readonly string[] {
  const keys = new Set<string>();
  for (const [, name = "", literal = "", extra, falsy] of sql.matchAll(
    HELPER_CALL,
  )) {
    const byPermission = /_permission$/iu.test(name);
    if (blind && byPermission && (extra === undefined || falsy !== undefined)) {
      continue;
    }
    const key = beforeFirst(literal.replaceAll("''", "'"), "#");
    if (key !== "") {
      keys.add(key);
    }
  }
  return [...keys];
}

export type HelperTablePolicy = {
  readonly table: (typeof HELPER_TABLES)[number];
  readonly name: string;
  /** The keys passed to helper calls that ignore row conditions. */
  readonly keys: readonly string[];
};

function tableName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

function helperTable(name: string): HelperTablePolicy["table"] | undefined {
  const table = tableName(name);
  return HELPER_TABLES.find((candidate) => candidate === table);
}

async function deparsed(expr: unknown): Promise<string> {
  if (expr === undefined) {
    return "";
  }
  // SAFETY: readPolicy takes expr from pgsql-parser's own parse tree, which deparse accepts.
  const text = await deparse(expr as Parameters<typeof deparse>[0]);
  return text;
}

/**
 * `create policy` statements on {@link HELPER_TABLES} in migration SQL, with
 * the keys their condition-blind helper calls pass. A file libpg_query rejects
 * has none; PD045 reports it.
 */
export async function helperTablePolicies(
  sql: string,
): Promise<readonly HelperTablePolicy[]> {
  let nodes: Awaited<ReturnType<typeof parseSqlFile>>;
  try {
    nodes = await parseSqlFile(sql);
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return [];
    }
    throw error;
  }
  const found: HelperTablePolicy[] = [];
  for (const node of nodes) {
    const policy = readPolicy(node);
    const table =
      policy === undefined
        ? undefined
        : helperTable(`${policy.schema}.${policy.table}`);
    if (policy === undefined || table === undefined) {
      continue;
    }
    const body = `${await deparsed(policy.using)} ${await deparsed(policy.check)}`;
    const keys = helperCallKeys(body, true);
    if (keys.length > 0) {
      found.push({ table, name: policy.name, keys });
    }
  }
  return found;
}

/**
 * `pg_policies` rows on {@link HELPER_TABLES}, read by `rls verify
 * --db-url-stdin`.
 */
export const HELPER_TABLE_POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
from pg_policies
where (schemaname, tablename) in (('storage', 'objects'), ('realtime', 'messages'))`;

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The same rows as {@link helperTablePolicies}, from `pg_policies`. */
export function helperTablePoliciesFromRows(
  rows: readonly Record<string, unknown>[],
): readonly HelperTablePolicy[] {
  const found: HelperTablePolicy[] = [];
  for (const row of rows) {
    const table = helperTable(textOf(row["target"]));
    const keys = helperCallKeys(textOf(row["body"]), true);
    if (table !== undefined && keys.length > 0) {
      found.push({ table, name: textOf(row["policyname"]), keys });
    }
  }
  return found;
}

/** The message PD037 and `rls verify --db-url-stdin` report for one policy. */
export function rowConditionMessage(
  policy: HelperTablePolicy,
  keys: readonly string[],
): string {
  return `${policy.table} policy '${policy.name}' calls the SQL helpers with ${keys.join(", ")}, whose grants carry row conditions the helpers do not check: the policy grants more than the application does`;
}

export const ROW_CONDITION_FIX =
  "call permitted_<scope>_ids_by_permission('<key>') or permdock_has_permission('<key>'), which count only the allows without a row condition (a relationship grant never reaches a topic or a folder), or use a permission whose catalog entry has rowConditions: false";

/**
 * Whether `expression` shows `coverage`: each equality is `and`ed with the
 * helper call, and each relation scope is read through `member_<scope>_ids`.
 */
export function conditionShown(
  expression: string,
  key: string,
  coverage:
    | {
        readonly equalities: readonly string[];
        readonly relations: readonly string[];
      }
    | undefined,
): boolean {
  if (
    coverage === undefined ||
    (coverage.equalities.length === 0 && coverage.relations.length === 0)
  ) {
    return false;
  }
  const equalities =
    coverage.equalities.length === 0 ||
    whereConjoined(expression, key, coverage.equalities);
  const relations = coverage.relations.every((scope) =>
    expression.toLowerCase().includes(`member_${scope}_ids`),
  );
  return equalities && relations;
}

function whereConjoined(
  expression: string,
  key: string,
  equalities: readonly string[],
): boolean {
  if (equalities.length === 0) {
    return false;
  }
  const text = sqlText(expression);
  const needle = `'${key}'`;
  return equalities.every((equality) => {
    const eqAt = text.indexOf(sqlText(equality));
    if (eqAt < 0) {
      return false;
    }
    let from = 0;
    let keyAt = text.indexOf(needle, from);
    while (keyAt >= 0) {
      if (joinedByAnd(text, keyAt, eqAt)) {
        return true;
      }
      from = keyAt + needle.length;
      keyAt = text.indexOf(needle, from);
    }
    return false;
  });
}

function sqlText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('"', "")
    .replaceAll(/'((?:[^']|'')*)'::[a-z_][a-z0-9_.]*/gu, "'$1'")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function joinedByAnd(text: string, a: number, b: number): boolean {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  let depth = 0;
  let min = Number.POSITIVE_INFINITY;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") {
      depth += 1;
    }
    if (index >= start && index <= end) {
      min = Math.min(min, depth);
    }
    if (text[index] === ")") {
      depth -= 1;
    }
  }
  depth = 0;
  let and = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") {
      depth += 1;
    }
    if (index >= start && index <= end && depth === min) {
      if (text.startsWith(" or ", index)) {
        return false;
      }
      if (text.startsWith(" and ", index)) {
        and = true;
      }
    }
    if (text[index] === ")") {
      depth -= 1;
    }
  }
  return and;
}
