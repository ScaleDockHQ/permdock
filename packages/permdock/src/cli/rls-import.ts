import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { SqlConnect } from './pg.ts';
import type { RolePermission } from './rls-helpers.ts';
import type { ImportedGrant } from './rls-import-ast.ts';
import type { ImportedFieldView } from './rls-import-views.ts';
import type { CliIo, PermDockConfig } from './types.ts';

import { usageResult } from './errors.ts';
import {
  emitPermissionsModule,
  emptySchema,
  isSchemaKind,
} from './generate.ts';
import { connectPg } from './pg.ts';
import {
  canonicalDump,
  conditionFromAst,
  fingerprintSql,
  helperGrants,
  seedFromRow,
  seedsFromSql,
} from './rls-import-ast.ts';
import { fieldViewsFromSql, viewsSqlFromDb } from './rls-import-views.ts';
import { parseMembershipsFlag } from './rls-sql.ts';

export type ImportOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

type ImportedPolicy = {
  readonly table: string;
  readonly cmd: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using?: string;
  readonly check?: string;
};

type CatalogEntry = {
  readonly table: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly condition: unknown;
  readonly fingerprint: string;
  readonly sourceSql: string;
  /** Role-gated branches read back from RLS helper calls and the `role_permissions` seeds. */
  readonly grants?: readonly ImportedGrant[];
};

const POLICY_RE =
  /create\s+policy\s+"?([A-Za-z0-9_]+)"?\s+on\s+"?([A-Za-z0-9_]+)"?([\s\S]*?);/gi;

function extractParenClause(sql: string, keyword: string): string | undefined {
  const match = new RegExp(`\\b${keyword}\\s*\\(`, 'i').exec(sql);
  if (match?.index === undefined) {
    return undefined;
  }
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(start, i).trim();
      }
    }
  }
  return undefined;
}

function splitPolicies(sql: string): ImportedPolicy[] {
  const out: ImportedPolicy[] = [];
  for (const match of sql.matchAll(POLICY_RE)) {
    const name = match[1] ?? 'policy';
    const table = match[2] ?? 'table';
    const body = match[3] ?? '';
    const clauses = body.search(/\b(?:using|with\s+check)\s*\(/i);
    const header = clauses === -1 ? body : body.slice(0, clauses);
    const asRestrictive = /\bas\s+restrictive\b/i.test(header);
    const cmdMatch = header.match(
      /\bfor\s+(all|select|insert|update|delete)\b/i,
    );
    const toMatch = header.match(/\bto\s+([^\n]+)/i);
    const using = extractParenClause(body, 'using');
    const check = extractParenClause(body, 'with\\s+check');
    const roles = (toMatch?.[1] ?? 'authenticated')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const cmd = (cmdMatch?.[1] ?? 'all').toUpperCase();
    const commands =
      cmd === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [cmd];
    for (const command of commands) {
      out.push({
        name,
        table,
        cmd: command,
        permissive: !asRestrictive,
        roles,
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    }
  }
  return out;
}

function actionsFor(cmds: readonly string[]): {
  readonly actions: readonly string[];
  readonly collection: readonly string[];
} {
  const actions: string[] = [];
  const collection: string[] = [];
  if (cmds.includes('SELECT')) {
    actions.push('read');
    collection.push('list');
  }
  if (cmds.includes('INSERT')) {
    collection.push('create');
  }
  if (cmds.includes('UPDATE')) {
    actions.push('update');
  }
  if (cmds.includes('DELETE')) {
    actions.push('delete');
  }
  if (actions.length === 0) {
    actions.push('read');
  }
  return { actions, collection };
}

function emitGenerated(
  catalog: readonly CatalogEntry[],
  fieldViews: readonly ImportedFieldView[],
  schema: string,
): string {
  const kind = isSchemaKind(schema) ? schema : 'zod';
  const tables = [...new Set(catalog.map((item) => item.table))];
  return emitPermissionsModule({
    generator: 'rls import',
    schema: kind,
    exports: fieldViews.length === 0 ? { catalog } : { catalog, fieldViews },
    resources: tables.map((table) => {
      const { actions, collection } = actionsFor(
        catalog.filter((item) => item.table === table).map((item) => item.cmd),
      );
      return {
        path: [table.replaceAll(/[^A-Za-z0-9_]/g, '_')],
        schema: emptySchema(kind),
        actions,
        collection,
      };
    }),
  });
}

function assertNoServiceRole(sql: string): void {
  if (/\bto\s+service_role\b|\bfrom\s+service_role\b/i.test(sql)) {
    throw new Error(
      'PermDock CLI: imported SQL must never target service_role',
    );
  }
}

type Query = (
  sql: string,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

async function seedsFromDb(query: Query): Promise<readonly RolePermission[]> {
  const tables = await query(
    `select table_schema from information_schema.tables where table_name = 'role_permissions' order by table_schema = 'permdock' desc, table_schema = 'public' desc, table_schema limit 1`,
  );
  const schema = tables.rows[0]?.['table_schema'];
  if (typeof schema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) {
    return [];
  }
  try {
    const rows = await query(
      `select role::text, permission::text, grant_key, scope, effect from "${schema}".role_permissions`,
    );
    return rows.rows.flatMap((row) => {
      const seed = seedFromRow(row);
      return seed === undefined ? [] : [seed];
    });
  } catch {
    // A pre-helper `role_permissions` (no grant_key) has nothing to map.
    return [];
  }
}

/** `pg_policies.roles` is a `name[]`, which `pg` returns as an array or, untyped, as `{a,b}`. */
function policyRoles(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === 'string'
    ? value
        .replaceAll(/[{}]/g, '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : [];
}

async function policiesFromDb(
  db: string,
  connect: SqlConnect,
): Promise<{
  readonly policies: ImportedPolicy[];
  readonly bodies: Map<string, string>;
  readonly seeds: readonly RolePermission[];
  readonly views: string;
}> {
  const client = await connect(db);
  const query: Query = (sql) => client.query(sql, []);
  try {
    const result = await query(
      `select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies`,
    );
    const bodies = new Map<string, string>();
    const procs = await query(`select proname, prosrc from pg_proc`);
    for (const row of procs.rows) {
      const { proname, prosrc } = row;
      if (typeof proname === 'string' && typeof prosrc === 'string') {
        bodies.set(proname, prosrc);
      }
    }
    const seeds = await seedsFromDb(query);
    const views = await viewsSqlFromDb(query);
    const policies: ImportedPolicy[] = [];
    for (const row of result.rows) {
      const { tablename, policyname, qual, with_check: check } = row;
      if (typeof tablename !== 'string' || typeof policyname !== 'string') {
        continue;
      }
      const cmd =
        typeof row['cmd'] === 'string' ? row['cmd'].toUpperCase() : 'ALL';
      const commands =
        cmd === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [cmd];
      for (const command of commands) {
        policies.push({
          name: policyname,
          table: tablename,
          cmd: command,
          permissive: row['permissive'] !== 'RESTRICTIVE',
          roles: policyRoles(row['roles']),
          ...(typeof qual === 'string' ? { using: qual } : {}),
          ...(typeof check === 'string' ? { check } : {}),
        });
      }
    }
    return { policies, bodies, seeds, views };
  } finally {
    await client.end();
  }
}

export async function runRlsImport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly sql?: string;
  readonly db?: string;
  readonly out?: string;
  readonly schema: string;
  readonly memberships?: string;
  readonly io: CliIo;
  /** Opens the `--db` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
}): Promise<ImportOutcome> {
  let policies: ImportedPolicy[] = [];
  let bodies = new Map<string, string>();
  let seeds: readonly RolePermission[] = [];
  let viewsSql = '';
  if (input.sql !== undefined) {
    const sqlPath = resolve(input.cwd, input.sql);
    if (!existsSync(sqlPath)) {
      return {
        code: 2,
        output: `PermDock CLI: SQL dump not found: ${input.sql}`,
      };
    }
    const sql = readFileSync(sqlPath, 'utf8');
    assertNoServiceRole(sql);
    viewsSql = sql;
    seeds = await seedsFromSql(sql);
    const canonical = await canonicalDump(sql);
    policies = splitPolicies(canonical ?? sql);
    if (policies.length === 0) {
      policies = splitPolicies(sql);
    }
  } else if (input.db !== undefined) {
    try {
      const fromDb = await policiesFromDb(
        input.db,
        input.connect ??
          ((db: string) => connectPg(db, 'permdock rls import --db')),
      );
      policies = fromDb.policies;
      bodies = fromDb.bodies;
      seeds = fromDb.seeds;
      viewsSql = fromDb.views;
    } catch (cause) {
      return usageResult(cause);
    }
  } else {
    return {
      code: 2,
      output: 'PermDock CLI: rls import needs --sql <file> or --db <url>',
    };
  }
  const memberships =
    parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
  const functions = input.config.rls?.functions;
  const unmapped: string[] = [];
  const joins: string[] = [];
  const catalog: CatalogEntry[] = [];
  for (const item of policies) {
    const sourceSql = item.using ?? item.check ?? 'true';
    const condition = await conditionFromAst(
      item.using ?? item.check,
      memberships,
      functions,
      unmapped,
      joins,
      seeds,
    );
    const grants = await helperGrants(
      item.using ?? item.check,
      memberships,
      functions,
      seeds,
    );
    catalog.push({
      table: item.table,
      cmd: item.cmd,
      permissive: item.permissive,
      roles: item.roles,
      condition,
      fingerprint: await fingerprintSql(sourceSql),
      sourceSql,
      ...(grants.length === 0 ? {} : { grants }),
    });
  }
  const fieldViews =
    viewsSql === ''
      ? []
      : await fieldViewsFromSql(viewsSql, memberships, functions, seeds);
  const outRel = input.out ?? 'src/permissions.generated.ts';
  const outPath = resolve(input.cwd, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, emitGenerated(catalog, fieldViews, input.schema));
  const unique = [...new Set(unmapped)];
  const hints = [
    ...uniqueHints(unique, bodies),
    ...[...new Set(joins)].map(membershipHint),
    ...fieldViews.map(fieldViewHint),
  ];
  return {
    code: 0,
    output:
      hints.length === 0
        ? `wrote ${outRel}`
        : `wrote ${outRel}\n${hints.join('\n')}`,
  };
}

function fieldViewHint(view: ImportedFieldView): string {
  return `field view ${view.view} over ${view.table}: ${view.restricted.map((item) => item.column).join(', ')} are field-limited; set fields on the read grants that list them (fieldViews export)`;
}

function membershipHint(table: string): string {
  return [
    `exists over ${table} stayed opaque; if it holds memberships, map it in permdock.config.ts:`,
    `// rls: { memberships: { tenant: { table: '${table}', user: 'user_id', tenant: 'tenant_id', role: 'role' } } }`,
  ].join('\n');
}

function uniqueHints(
  names: readonly string[],
  bodies: ReadonlyMap<string, string>,
): readonly string[] {
  const lines: string[] = [];
  for (const name of names) {
    const short = name.includes('.')
      ? name.slice(name.lastIndexOf('.') + 1)
      : name;
    lines.push(`add rls.functions.${short} to make this grant portable`);
    const body = bodies.get(short) ?? bodies.get(name);
    if (body !== undefined) {
      lines.push(`-- ${name}: ${body.trim().slice(0, 240)}`);
    }
  }
  return lines;
}
