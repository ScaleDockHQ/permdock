import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse } from 'pgsql-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conditionFromAst } from '../../src/cli/rls-import-ast.ts';
import { run } from '../../src/cli/run.ts';

type Node = Record<string, unknown>;

const FIXTURE = path.join(import.meta.dirname, '../fixtures/rls-standard.ts');
const TMP = path.join(import.meta.dirname, '../../tmp');
const DIALECTS = ['supabase', 'neon', 'guc'] as const;
type Dialect = (typeof DIALECTS)[number];
const ANON: Readonly<Record<Dialect, string>> = {
  supabase: 'anon',
  neon: 'anonymous',
  guc: 'anon',
};
const SUBJECT_FUNCTIONS = new Set([
  'auth.uid',
  'auth.jwt',
  'auth.user_id',
  'auth.session',
  'current_setting',
]);
const HELPER = /^public\.(permdock_has|permitted_\w+_ids|member_\w+_ids)$/u;

let cwd = '';
const generated: Partial<Record<Dialect, string>> = {};

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  cwd = mkdtempSync(path.join(TMP, 'rls-standard-'));
  writeFileSync(
    path.join(cwd, 'permdock.config.ts'),
    `export default {
  permissions: ${JSON.stringify(FIXTURE)},
  policy: ${JSON.stringify(FIXTURE)},
  rls: { authorize: 'jwt', tenantType: 'text' },
};
`,
  );
  for (const dialect of DIALECTS) {
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        dialect,
        '--out',
        `${dialect}.sql`,
      ],
      { cwd },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate --dialect ${dialect}: ${result.stderr}`);
    }
    generated[dialect] = readFileSync(path.join(cwd, `${dialect}.sql`), 'utf8');
  }
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function child(node: unknown, key: string): Node | undefined {
  const value = isNode(node) ? node[key] : undefined;
  return isNode(value) ? value : undefined;
}

function list(node: unknown, key: string): readonly unknown[] {
  const value = isNode(node) ? node[key] : undefined;
  return Array.isArray(value) ? value : [];
}

function names(items: readonly unknown[]): string {
  return items
    .map((item) => child(item, 'String')?.['sval'])
    .filter((item): item is string => typeof item === 'string')
    .join('.');
}

async function statements(dialect: Dialect): Promise<readonly Node[]> {
  const parsed: unknown = await parse(generated[dialect] ?? '');
  return list(parsed, 'stmts').flatMap((item) => {
    const stmt = child(item, 'stmt');
    return stmt === undefined ? [] : [stmt];
  });
}

type Policy = {
  readonly table: string;
  readonly name: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly qual?: Node;
  readonly check?: Node;
  readonly index: number;
};

function roleNames(items: readonly unknown[]): string[] {
  return items.map((item) => {
    const role = child(item, 'RoleSpec');
    return role?.['roletype'] === 'ROLESPEC_PUBLIC'
      ? 'PUBLIC'
      : String(role?.['rolename']);
  });
}

/** A `RangeVar` as `schema.table`, or `table` when it names no schema. */
function rangeName(range: Node | undefined): string {
  return [range?.['schemaname'], range?.['relname']]
    .filter((part) => part !== undefined)
    .map(String)
    .join('.');
}

async function policies(dialect: Dialect): Promise<readonly Policy[]> {
  return (await statements(dialect)).flatMap((stmt, index) => {
    const policy = child(stmt, 'CreatePolicyStmt');
    if (policy === undefined) {
      return [];
    }
    const qual = child(policy, 'qual');
    const check = child(policy, 'with_check');
    return [
      {
        table: rangeName(child(policy, 'table')),
        name: String(policy['policy_name']),
        cmd: String(policy['cmd_name']),
        permissive: policy['permissive'] === true,
        roles: roleNames(list(policy, 'roles')),
        ...(qual === undefined ? {} : { qual }),
        ...(check === undefined ? {} : { check }),
        index,
      },
    ];
  });
}

/** Every function call in an expression, with whether a sublink encloses it and whether its arguments read a column. */
function calls(
  node: unknown,
  inSubLink = false,
  out: { name: string; inSubLink: boolean; readsColumn: boolean }[] = [],
): typeof out {
  if (Array.isArray(node)) {
    for (const item of node) {
      calls(item, inSubLink, out);
    }
    return out;
  }
  if (!isNode(node)) {
    return out;
  }
  const call = child(node, 'FuncCall');
  if (call !== undefined) {
    out.push({
      name: names(list(call, 'funcname')),
      inSubLink,
      readsColumn: JSON.stringify(call['args'] ?? []).includes('"ColumnRef"'),
    });
  }
  for (const [key, value] of Object.entries(node)) {
    calls(value, inSubLink || key === 'SubLink', out);
  }
  return out;
}

describe.each(DIALECTS)('rls generate --dialect %s', (dialect) => {
  it('writes SQL that Postgres parses', async () => {
    expect((await statements(dialect)).length).toBeGreaterThan(0);
  });

  it('puts only the clauses CREATE POLICY allows on each command', async () => {
    for (const policy of await policies(dialect)) {
      const clauses = {
        name: policy.name,
        using: policy.qual !== undefined,
        check: policy.check !== undefined,
      };
      switch (policy.cmd) {
        case 'select':
        case 'delete':
          expect(clauses).toEqual({
            name: policy.name,
            using: true,
            check: false,
          });
          break;
        case 'insert':
          expect(clauses).toEqual({
            name: policy.name,
            using: false,
            check: true,
          });
          break;
        case 'update':
          expect(clauses.using).toBe(true);
          break;
        default:
          expect.unreachable(`${policy.name} uses FOR ${policy.cmd}`);
      }
    }
  });

  it('targets named roles only: never PUBLIC, never service_role', async () => {
    const roles = new Set(
      (await policies(dialect)).flatMap((policy) => policy.roles),
    );
    expect([...roles].toSorted()).toEqual(
      [ANON[dialect], 'authenticated'].toSorted(),
    );
    expect(generated[dialect]).not.toMatch(/\bservice_role\b/u);
  });

  it('leaves each role one permissive and one restrictive policy per table and command', async () => {
    const seen = new Map<string, string>();
    for (const policy of await policies(dialect)) {
      for (const role of policy.roles) {
        const id = `${policy.table} ${policy.cmd} ${role} ${policy.permissive ? 'permissive' : 'restrictive'}`;
        expect({ id, other: seen.get(id) }).toEqual({ id, other: undefined });
        seen.set(id, policy.name);
      }
    }
  });

  it('negates the deny condition in each restrictive policy', async () => {
    const restrictive = (await policies(dialect)).filter(
      (policy) => !policy.permissive,
    );
    expect(restrictive.map((policy) => policy.name)).toEqual([
      'deny_post_delete',
    ]);
    for (const policy of restrictive) {
      expect(child(policy.qual, 'BoolExpr')?.['boolop']).toBe('NOT_EXPR');
    }
  });

  it('gives every role with an update or delete policy a select policy', async () => {
    const all = await policies(dialect);
    for (const policy of all.filter(
      (item) =>
        item.permissive && (item.cmd === 'update' || item.cmd === 'delete'),
    )) {
      for (const role of policy.roles) {
        expect({
          policy: policy.name,
          role,
          select: all.some(
            (item) =>
              item.permissive &&
              item.table === policy.table &&
              item.cmd === 'select' &&
              item.roles.includes(role),
          ),
        }).toEqual({ policy: policy.name, role, select: true });
      }
    }
  });

  it('drops each policy if it exists before creating it, so the script is idempotent', async () => {
    const stmts = await statements(dialect);
    for (const policy of await policies(dialect)) {
      const dropped = stmts.slice(0, policy.index).some((stmt) => {
        const drop = child(stmt, 'DropStmt');
        return (
          drop?.['removeType'] === 'OBJECT_POLICY' &&
          drop['missing_ok'] === true &&
          names(list(child(list(drop, 'objects')[0], 'List'), 'items')) ===
            `${policy.table}.${policy.name}`
        );
      });
      expect({ policy: policy.name, dropped }).toEqual({
        policy: policy.name,
        dropped: true,
      });
    }
  });

  it('enables row level security and owns the grants of every policy table', async () => {
    const stmts = await statements(dialect);
    const all = await policies(dialect);
    for (const table of new Set(all.map((policy) => policy.table))) {
      expect(
        stmts.some(
          (stmt) =>
            rangeName(child(child(stmt, 'AlterTableStmt'), 'relation')) ===
              table && JSON.stringify(stmt).includes('AT_EnableRowSecurity'),
        ),
      ).toBe(true);
      const grants = stmts.flatMap((stmt) => {
        const grant = child(stmt, 'GrantStmt');
        const target = child(list(grant, 'objects')[0], 'RangeVar');
        return grant?.['objtype'] === 'OBJECT_TABLE' &&
          rangeName(target) === table
          ? [grant]
          : [];
      });
      expect(grants[0]?.['is_grant']).toBeUndefined();
      expect(roleNames(list(grants[0], 'grantees')).toSorted()).toEqual(
        [ANON[dialect], 'authenticated'].toSorted(),
      );
      for (const role of [ANON[dialect], 'authenticated']) {
        const granted = grants
          .filter(
            (grant) =>
              grant['is_grant'] === true &&
              roleNames(list(grant, 'grantees')).includes(role),
          )
          .flatMap((grant) =>
            list(grant, 'privileges').map((item) =>
              String(child(item, 'AccessPriv')?.['priv_name']),
            ),
          );
        const allowed = all
          .filter((policy) => policy.permissive && policy.roles.includes(role))
          .map((policy) => policy.cmd);
        expect({ role, granted: [...new Set(granted)].toSorted() }).toEqual({
          role,
          granted: [...new Set(allowed)].toSorted(),
        });
      }
    }
  });

  it('wraps subject reads and helper calls so each runs once per statement', async () => {
    for (const policy of await policies(dialect)) {
      for (const call of calls([policy.qual, policy.check])) {
        if (SUBJECT_FUNCTIONS.has(call.name) || HELPER.test(call.name)) {
          expect({
            policy: policy.name,
            call: call.name,
            inSubLink: call.inSubLink,
          }).toEqual({
            policy: policy.name,
            call: call.name,
            inSubLink: true,
          });
        }
        if (HELPER.test(call.name)) {
          expect({ call: call.name, readsColumn: call.readsColumn }).toEqual({
            call: call.name,
            readsColumn: false,
          });
        }
      }
    }
  });

  it('pins security definer helpers to an empty search_path and revokes them from PUBLIC', async () => {
    const stmts = await statements(dialect);
    const definers = stmts.flatMap((stmt) => {
      const fn = child(stmt, 'CreateFunctionStmt');
      const options = list(fn, 'options').map((item) => child(item, 'DefElem'));
      const definer = options.some(
        (option) =>
          option?.['defname'] === 'security' &&
          child(option, 'arg')?.['Boolean'] !== undefined &&
          child(child(option, 'arg'), 'Boolean')?.['boolval'] === true,
      );
      if (fn === undefined || !definer) {
        return [];
      }
      const searchPath = options.find(
        (option) =>
          option?.['defname'] === 'set' &&
          child(child(option, 'arg'), 'VariableSetStmt')?.['name'] ===
            'search_path',
      );
      const value = list(
        child(child(searchPath, 'arg'), 'VariableSetStmt'),
        'args',
      )[0];
      return [
        {
          name: names(list(fn, 'funcname')),
          searchPath: child(child(value, 'A_Const'), 'sval')?.['sval'],
        },
      ];
    });
    expect(definers.length).toBeGreaterThan(0);
    for (const definer of definers) {
      expect(definer).toEqual({ name: definer.name, searchPath: '' });
      expect(definer.name.split('.')).toHaveLength(2);
      const revoked = stmts.some((stmt) => {
        const grant = child(stmt, 'GrantStmt');
        return (
          grant?.['objtype'] === 'OBJECT_FUNCTION' &&
          grant['is_grant'] !== true &&
          names(
            list(child(list(grant, 'objects')[0], 'ObjectWithArgs'), 'objname'),
          ) === definer.name &&
          roleNames(list(grant, 'grantees')).includes('PUBLIC')
        );
      });
      expect({ name: definer.name, revoked }).toEqual({
        name: definer.name,
        revoked: true,
      });
    }
  });
});

describe('rls import reads the generated forms back', () => {
  it('maps the wrapped subject of every dialect to principal.id', async () => {
    for (const subject of [
      '(select auth.uid())',
      '(select auth.user_id())',
      "(select current_setting('app.user_id', true))",
    ]) {
      expect(
        await conditionFromAst(
          `"authorId" = ${subject}`,
          undefined,
          undefined,
          [],
        ),
      ).toEqual({
        op: 'eq',
        field: 'authorId',
        value: { ref: 'principal.id' },
      });
    }
  });
});
