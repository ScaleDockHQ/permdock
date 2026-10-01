import { HELPERS } from './rls-helpers.ts';

/**
 * Tables whose policies other packages write (better-supabase `defineBucket`
 * and `defineTopic` in `permdock` mode) by calling the SQL helpers directly.
 */
export const HELPER_TABLES = ['storage.objects', 'realtime.messages'] as const;

const HELPER_CALL = new RegExp(
  String.raw`\b(?:${HELPERS.has}|permitted_[a-z][a-z0-9_]*_ids)\s*\(\s*'((?:[^']|'')+)'`,
  'giu',
);

const ANY_HELPER = new RegExp(
  String.raw`\b(?:${HELPERS.has}|permitted_[a-z][a-z0-9_]*_ids|member_[a-z][a-z0-9_]*_ids)\s*\(`,
  'iu',
);

/** Whether a policy expression calls any generated helper, the key-less `member_<scope>_ids` included. */
export function callsHelper(sql: string): boolean {
  return ANY_HELPER.test(sql);
}

/** The permission keys a policy expression passes to `permdock_has` or `permitted_<scope>_ids`, `#n` stripped. */
export function helperCallKeys(sql: string): readonly string[] {
  const keys = new Set<string>();
  for (const [, literal = ''] of sql.matchAll(HELPER_CALL)) {
    const key = literal.replaceAll("''", "'").split('#')[0] ?? '';
    if (key !== '') {
      keys.add(key);
    }
  }
  return [...keys];
}

export type HelperTablePolicy = {
  readonly table: (typeof HELPER_TABLES)[number];
  readonly name: string;
  readonly keys: readonly string[];
};

const CREATE_POLICY =
  /\bcreate\s+policy\s+("(?:[^"]|"")+"|\w+)\s+on\s+((?:"[^"]+"|\w+)\.(?:"[^"]+"|\w+))([\s\S]*?);/giu;

function tableName(name: string): string {
  return name.replaceAll('"', '').toLowerCase();
}

function helperTable(name: string): HelperTablePolicy['table'] | undefined {
  const table = tableName(name);
  return HELPER_TABLES.find((candidate) => candidate === table);
}

/** `create policy` statements on {@link HELPER_TABLES} in migration SQL, with the keys their helper calls pass. */
export function helperTablePolicies(sql: string): readonly HelperTablePolicy[] {
  const text = sql
    .replaceAll(/--[^\n]*/gu, '')
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  const found: HelperTablePolicy[] = [];
  for (const [, name = '', target = '', body = ''] of text.matchAll(
    CREATE_POLICY,
  )) {
    const table = helperTable(target);
    const keys = helperCallKeys(body);
    if (table !== undefined && keys.length > 0) {
      found.push({ table, name: name.replaceAll('"', ''), keys });
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
    const table = helperTable(String(row['target'] ?? ''));
    const keys = helperCallKeys(String(row['body'] ?? ''));
    if (table !== undefined && keys.length > 0) {
      found.push({ table, name: String(row['policyname'] ?? ''), keys });
    }
  }
  return found;
}

/** The message PD037 and `rls verify --db` report for one policy. */
export function rowConditionMessage(
  policy: HelperTablePolicy,
  keys: readonly string[],
): string {
  return `${policy.table} policy '${policy.name}' calls the SQL helpers with ${keys.join(', ')}, whose grants carry row conditions the helpers do not check: the policy grants more than the application does`;
}

export const ROW_CONDITION_FIX =
  'use permissions whose catalog entry has rowConditions: false for storage and realtime policies, or write the condition into the policy yourself';
