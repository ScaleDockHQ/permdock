import { HELPERS } from "./rls-shared.ts";

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

/** Whether a policy expression calls any generated helper, the key-less `member_<scope>_ids` included. */
export function callsHelper(sql: string): boolean {
  return ANY_HELPER.test(sql);
}

/**
 * The permission keys a policy expression passes to `permdock_has`,
 * `permitted_<scope>_ids` or their permission-key forms, `#n` stripped. With
 * `blind`, only the calls that ignore row conditions: the grant-key forms,
 * and a permission-key form asked for conditioned allows. A plain
 * `permdock_has_permission(key)` or `permitted_<scope>_ids_by_permission(key)`
 * counts only allows without a row condition, so it never grants more than
 * the application does.
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
    const key = literal.replaceAll("''", "'").split("#")[0] ?? "";
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

const CREATE_POLICY =
  /\bcreate\s+policy\s+("(?:[^"]|"")+"|\w+)\s+on\s+((?:"[^"]+"|\w+)\.(?:"[^"]+"|\w+))([\s\S]*?);/giu;

function tableName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

function helperTable(name: string): HelperTablePolicy["table"] | undefined {
  const table = tableName(name);
  return HELPER_TABLES.find((candidate) => candidate === table);
}

/** `create policy` statements on {@link HELPER_TABLES} in migration SQL, with the keys their condition-blind helper calls pass. */
export function helperTablePolicies(sql: string): readonly HelperTablePolicy[] {
  const text = sql
    .replaceAll(/--[^\n]*/gu, "")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const found: HelperTablePolicy[] = [];
  for (const [, name = "", target = "", body = ""] of text.matchAll(
    CREATE_POLICY,
  )) {
    const table = helperTable(target);
    const keys = helperCallKeys(body, true);
    if (table !== undefined && keys.length > 0) {
      found.push({ table, name: name.replaceAll('"', ""), keys });
    }
  }
  return found;
}

/** `pg_policies` rows on {@link HELPER_TABLES}, read by `rls verify --db`. */
export const HELPER_TABLE_POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
from pg_policies
where (schemaname, tablename) in (('storage', 'objects'), ('realtime', 'messages'))`;

/** The same rows as {@link helperTablePolicies}, from `pg_policies`. */
export function helperTablePoliciesFromRows(
  rows: readonly Record<string, unknown>[],
): readonly HelperTablePolicy[] {
  const found: HelperTablePolicy[] = [];
  for (const row of rows) {
    const table = helperTable(String(row["target"] ?? ""));
    const keys = helperCallKeys(String(row["body"] ?? ""), true);
    if (table !== undefined && keys.length > 0) {
      found.push({ table, name: String(row["policyname"] ?? ""), keys });
    }
  }
  return found;
}

/** The message PD037 and `rls verify --db` report for one policy. */
export function rowConditionMessage(
  policy: HelperTablePolicy,
  keys: readonly string[],
): string {
  return `${policy.table} policy '${policy.name}' calls the SQL helpers with ${keys.join(", ")}, whose grants carry row conditions the helpers do not check: the policy grants more than the application does`;
}

export const ROW_CONDITION_FIX =
  "call permitted_<scope>_ids_by_permission('<key>') or permdock_has_permission('<key>'), which count only the allows without a row condition (a relationship grant never reaches a topic or a folder), or use a permission whose catalog entry has rowConditions: false";
