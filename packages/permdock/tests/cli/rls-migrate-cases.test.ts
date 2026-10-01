import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  MigrateReport,
  MigrateTarget,
} from '../../src/cli/rls-migrate.ts';
import type { RlsMigrateConfig } from '../../src/cli/types.ts';

import {
  mapKey,
  migrateTarget,
  runRlsMigrate,
} from '../../src/cli/rls-migrate.ts';

const TMP = path.join(import.meta.dirname, '../../tmp');
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(path.join(TMP, 'rls-migrate-cases-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG: RlsMigrateConfig = {
  helpers: {
    org_ids: { form: 'ids', scope: 'org' },
    team_ids: { form: 'ids', scope: 'team' },
    has_org: { form: 'row', scope: 'org' },
    authorize: { form: 'scoped' },
    is_admin: { form: 'global' },
    is_member: { form: 'membership', scope: 'org' },
    is_team_member: { form: 'membership', scope: 'team' },
  },
  scopes: { organization: 'org' },
};

function target(overrides: Partial<MigrateTarget> = {}): MigrateTarget {
  return {
    schema: 'public',
    sql: [
      'create or replace function "public".permitted_org_ids(',
      'create or replace function "public".permdock_has(',
      'create or replace function "public".member_org_ids(',
    ].join('\n'),
    permissions: new Set(['doc.read', 'doc.update', 'doc.secret', 'doc.audit']),
    rowConditions: new Set(['doc.secret']),
    granted: new Map([
      ['org', new Set(['doc.read', 'doc.update'])],
      ['global', new Set(['doc.read'])],
    ]),
    ...overrides,
  };
}

let counter = 0;
async function migrate(
  sql: string,
  options: {
    readonly target?: MigrateTarget;
    readonly config?: RlsMigrateConfig;
    readonly write?: boolean;
  } = {},
): Promise<{
  readonly code: number;
  readonly report: MigrateReport;
  readonly text: string;
}> {
  counter += 1;
  const cwd = path.join(root, String(counter));
  mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, 'policies.sql');
  writeFileSync(file, sql);
  const result = await runRlsMigrate({
    cwd,
    sql: 'policies.sql',
    config: options.config ?? CONFIG,
    target: options.target ?? target(),
    write: options.write ?? true,
    json: true,
  });
  // SAFETY: json: true prints the MigrateReport.
  const report = JSON.parse(result.output) as MigrateReport;
  return { code: result.code, report, text: readFileSync(file, 'utf8') };
}

function reasons(
  report: MigrateReport,
): readonly (readonly [string, string])[] {
  return report.skipped.map((item) => [item.reason, item.detail] as const);
}

describe('migrateTarget', () => {
  it('defaults the schema and keys of an outcome without them', () => {
    expect(migrateTarget({ code: 0, output: '', text: 'sql' })).toEqual({
      schema: 'public',
      sql: 'sql',
      permissions: new Set(),
      rowConditions: new Set(),
      granted: new Map(),
    });
  });
});

describe('mapKey without prefixes', () => {
  it('keeps an unmapped key', () => {
    expect(mapKey({ helpers: {} }, 'doc.read')).toBe('doc.read');
  });
});

describe('runRlsMigrate skips', () => {
  it.each([
    [
      'a missing ids helper',
      `create policy p on t using (team_id in (select team_ids('doc.read')));`,
      [
        'missing-helper',
        'rls generate writes no permitted_team_ids for this policy',
      ],
    ],
    [
      'a missing membership helper',
      `create policy p on t using (is_team_member(team_id));`,
      [
        'missing-helper',
        'rls generate writes no member_team_ids: team has no membership source',
      ],
    ],
    [
      'a membership id that is an expression',
      `create policy p on t using (is_member(lower(org_id)));`,
      [
        'not-a-column',
        'the id is an expression, not a plain column; rewrite it by hand',
      ],
    ],
    [
      'a scope that is not a literal',
      `create policy p on t using (authorize(scope_col, org_id, 'doc.read'));`,
      [
        'unknown-scope',
        'the scope is not a string literal; rewrite it by hand',
      ],
    ],
    [
      'a global key that is not granted anywhere',
      `create policy p on t using (is_admin('doc.audit'));`,
      [
        'not-granted-on-scope',
        'doc.audit has no role_permissions row: rls generate seeds only read, list, get, create, update and delete grants',
      ],
    ],
    [
      'a call it cannot delimit',
      `create policy p on t using (is_admin(E'\\''));`,
      ['not-a-column', 'the call could not be delimited'],
    ],
  ])('skips %s', async (_label, sql, expected) => {
    const { report, text } = await migrate(sql);
    expect(report.rewrites).toEqual([]);
    expect(reasons(report)).toEqual([expected]);
    expect(text).toBe(sql);
  });

  it('skips the global form when permdock_has is not generated', async () => {
    const { report } = await migrate(
      `create policy p on t using (is_admin('doc.read'));`,
      {
        target: target({ sql: '' }),
      },
    );
    expect(reasons(report)).toEqual([
      ['missing-helper', 'rls generate writes no permdock_has'],
    ]);
  });

  it('reports a file that does not parse, but only when it names a helper', async () => {
    const broken = await migrate(
      `create policy p on t using (is_admin('doc.read');`,
    );
    expect(broken.report.skipped).toMatchObject([
      { line: 1, call: '', reason: 'unparsed' },
    ]);
    expect(broken.report.skipped[0]?.detail).toMatch(
      /^the file does not parse: /u,
    );
    const unrelated = await migrate('not sql at all (');
    expect(unrelated.report).toEqual({ rewrites: [], skipped: [] });
  });

  it('reports calls in function bodies whose text is escaped', async () => {
    const sql = `create function f() returns boolean language sql as 'select is_admin(''doc.read'')';
do $$ begin perform org_ids('doc.read'); end $$;`;
    const { report } = await migrate(sql);
    expect(
      report.skipped.map((item) => [item.line, item.reason, item.call]),
    ).toEqual([
      [1, 'function-body', 'is_admin'],
      [2, 'function-body', 'org_ids'],
    ]);
  });
});

describe('runRlsMigrate rewrites', () => {
  it('maps scopes, quotes an unsafe schema and keeps comments and strings inside calls', async () => {
    const quoted = target({
      schema: 'App',
      sql: [
        'create or replace function "App".permitted_org_ids(',
        'create or replace function "App".permdock_has(',
      ].join('\n'),
    });
    const sql = `-- é and 😀 shift byte offsets
create policy p on t using (
  has_org(org_id, /* ) */ 'doc.read' -- )
  )
  or authorize('organization', org_id, 'doc.update')
  or authorize('global', null, 'doc.read')
);`;
    const { code, report, text } = await migrate(sql, { target: quoted });
    expect(code).toBe(0);
    expect(report.rewrites.map((item) => [item.line, item.to])).toEqual([
      [3, `(org_id in (select "App".permitted_org_ids('doc.read')))`],
      [5, `(org_id in (select "App".permitted_org_ids('doc.update')))`],
      [6, `(select "App".permdock_has('doc.read'))`],
    ]);
    expect(text).toBe(`-- é and 😀 shift byte offsets
create policy p on t using (
  (org_id in (select "App".permitted_org_ids('doc.read')))
  or (org_id in (select "App".permitted_org_ids('doc.update')))
  or (select "App".permdock_has('doc.read'))
);`);
  });

  it('leaves files alone on a dry run and reads a single file path', async () => {
    const sql = `create policy p on t using (is_member(org_id));`;
    const { report, text } = await migrate(sql, { write: false });
    expect(report.rewrites).toEqual([
      {
        file: 'policies.sql',
        line: 1,
        from: 'is_member(org_id)',
        to: '(org_id in (select public.member_org_ids()))',
      },
    ]);
    expect(text).toBe(sql);
  });

  it('prints a summary naming unknown keys', async () => {
    const cwd = path.join(root, 'summary');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, 'a.sql'),
      `create policy p on t using (is_admin('doc.nope') or is_admin('doc.read'));`,
    );
    const result = await runRlsMigrate({
      cwd,
      sql: 'a.sql',
      config: CONFIG,
      target: target(),
      write: true,
      json: false,
    });
    expect(result.code).toBe(1);
    expect(result.output.split('\n')).toEqual([
      "a.sql:1  is_admin('doc.read')  ->  (select public.permdock_has('doc.read'))",
      "skipped a.sql:1  is_admin('doc.nope'): doc.nope maps to doc.nope, which the policy does not declare; add it to rls.migrate.keys or the vocabulary",
      'rls migrate: rewrote 1 call(s) in 1 file(s), skipped 1, 1 with an unknown key',
    ]);
  });

  it('answers 2 for a missing --sql path', async () => {
    expect(
      await runRlsMigrate({
        cwd: root,
        sql: 'nowhere',
        config: CONFIG,
        target: target(),
        write: false,
        json: false,
      }),
    ).toEqual({ code: 2, output: 'rls migrate --sql: nowhere does not exist' });
  });
});
