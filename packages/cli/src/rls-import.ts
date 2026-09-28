import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { CliIo, PermDockConfig } from './types.ts';

import {
  emitPermissionsModule,
  emptySchema,
  isSchemaKind,
} from './generate.ts';
import {
  canonicalDump,
  conditionFromAst,
  fingerprintSql,
} from './rls-import-ast.ts';
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
};

const POLICY_RE =
  /create\s+policy\s+"?([A-Za-z0-9_]+)"?\s+on\s+"?([A-Za-z0-9_]+)"?([\s\S]*?);/gi;

function extractParenClause(sql: string, keyword: string): string | undefined {
  const match = new RegExp(`\\b${keyword}\\s*\\(`, 'i').exec(sql);
  if (match === null || match.index === undefined) {
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
    const asRestrictive = /\bas\s+restrictive\b/i.test(body);
    const cmdMatch = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i);
    const toMatch = body.match(/\bto\s+([^\n]+)/i);
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
  schema: string,
): string {
  const kind = isSchemaKind(schema) ? schema : 'zod';
  const tables = [...new Set(catalog.map((item) => item.table))];
  return emitPermissionsModule({
    generator: 'rls import',
    schema: kind,
    exports: { catalog },
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

async function loadPg(): Promise<typeof import('pg')> {
  try {
    // Optional peer: import `--db` is the only path that talks to Postgres.
    return await import('pg');
  } catch {
    throw new Error(
      'PermDock CLI: rls import --db requires the optional pg peer',
    );
  }
}

async function policiesFromDb(db: string): Promise<{
  readonly policies: ImportedPolicy[];
  readonly bodies: Map<string, string>;
}> {
  const pg = await loadPg();
  const client = new pg.Client({ connectionString: db });
  await client.connect();
  try {
    const result = await client.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string[] | string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies`,
    );
    const bodies = new Map<string, string>();
    const procs = await client.query<{ proname: string; prosrc: string }>(
      `select proname, prosrc from pg_proc`,
    );
    for (const row of procs.rows) {
      bodies.set(row.proname, row.prosrc);
    }
    const policies: ImportedPolicy[] = [];
    for (const row of result.rows) {
      const roles = Array.isArray(row.roles)
        ? row.roles
        : row.roles
            .replaceAll(/[{}]/g, '')
            .split(',')
            .map((item) => item.trim());
      const cmd = (row.cmd ?? 'ALL').toUpperCase();
      const commands =
        cmd === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [cmd];
      for (const command of commands) {
        policies.push({
          name: row.policyname,
          table: row.tablename,
          cmd: command,
          permissive: row.permissive !== 'RESTRICTIVE',
          roles,
          ...(row.qual === null || row.qual === undefined
            ? {}
            : { using: row.qual }),
          ...(row.with_check === null || row.with_check === undefined
            ? {}
            : { check: row.with_check }),
        });
      }
    }
    return { policies, bodies };
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
}): Promise<ImportOutcome> {
  let policies: ImportedPolicy[] = [];
  let bodies = new Map<string, string>();
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
    const canonical = await canonicalDump(sql);
    policies = splitPolicies(canonical ?? sql);
    if (policies.length === 0) {
      policies = splitPolicies(sql);
    }
  } else if (input.db !== undefined) {
    try {
      const fromDb = await policiesFromDb(input.db);
      policies = fromDb.policies;
      bodies = fromDb.bodies;
    } catch (cause) {
      return {
        code: 2,
        output: cause instanceof Error ? cause.message : String(cause),
      };
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
    );
    catalog.push({
      table: item.table,
      cmd: item.cmd,
      permissive: item.permissive,
      roles: item.roles,
      condition,
      fingerprint: await fingerprintSql(sourceSql),
      sourceSql,
    });
  }
  const outRel = input.out ?? 'src/permissions.generated.ts';
  const outPath = resolve(input.cwd, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, emitGenerated(catalog, input.schema));
  const unique = [...new Set(unmapped)];
  const hints = [
    ...uniqueHints(unique, bodies),
    ...[...new Set(joins)].map(membershipHint),
  ];
  return {
    code: 0,
    output:
      hints.length === 0
        ? `wrote ${outRel}`
        : `wrote ${outRel}\n${hints.join('\n')}`,
  };
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
