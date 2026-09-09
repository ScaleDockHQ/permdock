import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { CliIo, PermDockConfig, RlsMemberships } from './types.ts';

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

function fingerprintOf(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
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
    const usingMatch = body.match(
      /\busing\s*\(([\s\S]*?)\)(?:\s+with\s+check|\s*$)/i,
    );
    const checkMatch = body.match(/\bwith\s+check\s*\(([\s\S]*?)\)\s*$/i);
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
        ...(usingMatch?.[1] === undefined
          ? {}
          : { using: usingMatch[1].trim() }),
        ...(checkMatch?.[1] === undefined
          ? {}
          : { check: checkMatch[1].trim() }),
      });
    }
  }
  return out;
}

function fieldFromEq(sql: string): string | undefined {
  const match = sql.match(/"([A-Za-z_][A-Za-z0-9_]*)"/);
  return match?.[1];
}

function conditionFromSql(
  sql: string | undefined,
  memberships: RlsMemberships | undefined,
): unknown {
  if (sql === undefined || sql === 'true') {
    return { op: 'eq', field: '_', value: true };
  }
  if (
    /\(select\s+auth\.uid\(\)\)/i.test(sql) ||
    /\(select\s+auth\.user_id\(\)\)/i.test(sql) ||
    /current_setting\('app\.user_id'/i.test(sql)
  ) {
    const field = fieldFromEq(sql) ?? 'id';
    return { op: 'eq', field, value: { ref: 'subject.id' } };
  }
  const exists = sql.match(
    /exists\s*\(\s*select\s+1\s+from\s+"?([A-Za-z0-9_]+)"?/i,
  );
  if (exists?.[1] !== undefined) {
    const table = exists[1];
    const tenantTable = memberships?.tenant?.table;
    const teamTable = memberships?.team?.table;
    if (tenantTable === table) {
      return {
        op: 'memberOf',
        scope: 'tenant',
        field: memberships?.tenant?.tenant ?? 'tenant_id',
        roles: [],
      };
    }
    if (teamTable === table) {
      return {
        op: 'memberOf',
        scope: 'team',
        field: memberships?.team?.team ?? 'team_id',
        roles: [],
      };
    }
    return {
      op: 'opaque',
      sql,
      fingerprint: fingerprintOf(sql),
    };
  }
  return { op: 'opaque', sql, fingerprint: fingerprintOf(sql) };
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

function schemaImport(kind: string): string {
  switch (kind) {
    case 'valibot':
      return "import * as v from 'valibot'";
    case 'arktype':
      return "import { type } from 'arktype'";
    default:
      return "import { z } from 'zod'";
  }
}

function schemaExpr(kind: string): string {
  switch (kind) {
    case 'valibot':
      return 'v.object({})';
    case 'arktype':
      return 'type({})';
    default:
      return 'z.object({})';
  }
}

function emitGenerated(
  catalog: readonly CatalogEntry[],
  schema: string,
): string {
  const tables = [...new Set(catalog.map((item) => item.table))];
  const resources = tables.map((table) => {
    const cmds = catalog
      .filter((item) => item.table === table)
      .map((item) => item.cmd);
    const { actions, collection } = actionsFor(cmds);
    const ident = table.replaceAll(/[^A-Za-z0-9_]/g, '_');
    return `  ${ident}: resource(${schemaExpr(schema)}, {
    id: 'id',
    actions: ${JSON.stringify(actions)},
    collection: ${JSON.stringify(collection)},
  }),`;
  });
  return `// @generated by permdock rls import
import { definePermissions, resource } from 'permdock'
${schemaImport(schema)}

export const catalog = ${JSON.stringify(catalog, null, 2)} as const

export const permissions = definePermissions({
${resources.join('\n')}
})
`;
}

function assertNoServiceRole(sql: string): void {
  if (/\bto\s+service_role\b|\bfrom\s+service_role\b/i.test(sql)) {
    throw new Error(
      'PermDock CLI: imported SQL must never target service_role',
    );
  }
}

export function runRlsImport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly sql?: string;
  readonly db?: string;
  readonly out?: string;
  readonly schema: string;
  readonly memberships?: string;
  readonly io: CliIo;
}): ImportOutcome {
  if (input.db !== undefined && input.sql === undefined) {
    return {
      code: 2,
      output:
        'PermDock CLI: rls import --db needs a live catalog reader; pass --sql for a dump in this release',
    };
  }
  if (input.sql === undefined) {
    return {
      code: 2,
      output: 'PermDock CLI: rls import needs --sql <file> or --db <url>',
    };
  }
  const sqlPath = resolve(input.cwd, input.sql);
  if (!existsSync(sqlPath)) {
    return {
      code: 2,
      output: `PermDock CLI: SQL dump not found: ${input.sql}`,
    };
  }
  const sql = readFileSync(sqlPath, 'utf8');
  assertNoServiceRole(sql);
  const memberships =
    parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
  const policies = splitPolicies(sql);
  const catalog: CatalogEntry[] = policies.map((item) => {
    const sourceSql = item.using ?? item.check ?? 'true';
    return {
      table: item.table,
      cmd: item.cmd,
      permissive: item.permissive,
      roles: item.roles,
      condition: conditionFromSql(item.using ?? item.check, memberships),
      fingerprint: fingerprintOf(sourceSql),
      sourceSql,
    };
  });
  const outRel = input.out ?? 'src/permissions.generated.ts';
  const outPath = resolve(input.cwd, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, emitGenerated(catalog, input.schema));
  return { code: 0, output: `wrote ${outRel}` };
}
