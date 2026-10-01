import { afterAll, describe, expect, it } from 'vitest';

import type { PermDockConfig } from '../../src/cli/types.ts';

import { runUsage, type UsageReport } from '../../src/cli/usage.ts';
import {
  NOW,
  PERMISSIONS,
  policyModule,
  project,
  quietIo,
  removeProjects,
} from './doctor-kit.ts';

afterAll(removeProjects);

const CONFIG: PermDockConfig = {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  collect: { srcPath: ['./src'] },
};

async function usage(
  cwd: string,
  options: {
    readonly config?: PermDockConfig;
    readonly ignore?: readonly string[];
    readonly strict?: boolean;
    readonly json?: boolean;
    readonly dynamicAsUsed?: boolean;
  } = {},
): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  return runUsage({
    cwd,
    config: options.config ?? CONFIG,
    ignore: options.ignore ?? [],
    strict: options.strict ?? false,
    json: options.json ?? true,
    dynamicAsUsed: options.dynamicAsUsed ?? false,
    now: NOW,
    io: quietIo,
  });
}

function report(output: string): UsageReport {
  // SAFETY: the --json report runUsage prints.
  return JSON.parse(output) as UsageReport;
}

describe('runUsage setup errors', () => {
  it('exits 2 without permissions, without a policy, or with a policy that does not load', async () => {
    const cwd = project({
      'src/permissions.ts': PERMISSIONS,
      'src/not-policy.ts': 'export const policy = 5;\n',
    });
    expect(
      await usage(cwd, { config: { permissions: './src/absent.ts' } }),
    ).toEqual({
      code: 2,
      output: 'PermDock CLI: permissions module not found: src/absent.ts',
    });
    expect(await usage(cwd, { config: {} })).toEqual({
      code: 2,
      output: 'usage: set policy in permdock.config.ts',
    });
    expect(await usage(cwd, { config: { policy: './src/absent.ts' } })).toEqual(
      {
        code: 2,
        output: 'PermDock CLI: policy module not found: ./src/absent.ts',
      },
    );
    expect(
      await usage(cwd, { config: { policy: './src/not-policy.ts' } }),
    ).toEqual({
      code: 2,
      output: 'PermDock CLI: policy export is not a Policy',
    });
  });
});

/**
 * A policy-shaped export whose grants carry every condition operator, so the
 * walk over condition fields is checked without definePolicy's own rules.
 */
const CONDITIONS = `import { permissions } from './permissions.ts';

const read = permissions.post.read;
const ghost = { key: 'ghost.read', resource: 'ghost', action: 'read', scope: 'global', meta: {} };

export const policy = {
  permissions,
  roles: [],
  grants: [
    {
      permission: read, effect: 'allow', role: null,
      where: { op: 'and', conditions: [
        { op: 'eq', field: 'authorId.nested', value: 'x' },
        { op: 'or', conditions: [{ op: 'ne', field: 'w1', value: 1 }] },
      ] },
      check: { op: 'not', condition: { op: 'isNull', field: 'w2', value: true } },
    },
    {
      permission: read, effect: 'allow', role: 'member',
      where: { op: 'memberOf', scope: 'tenant', field: 'w3', roles: ['a'], parents: ['w4', { field: 'w5', resource: 'org' }] },
    },
    { permission: read, effect: 'allow', role: null, where: { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['a'] } },
    {
      permission: read, effect: 'allow', role: null,
      where: { op: 'sqlFunction', name: 'f', args: [{ field: 'w6' }, 'literal', null, [1]], twin: { op: 'gt', field: 'w7', value: 1 } },
    },
    { permission: read, effect: 'allow', role: null, where: { op: 'related', resource: 'post', relation: 'r', field: 'w8', depth: 0, restricted: 'w9' } },
    { permission: read, effect: 'allow', role: null, where: { op: 'related', resource: 'post', relation: 'r', field: 'id', depth: 0 } },
    { permission: read, effect: 'allow', role: null, where: { op: 'opaque', sql: 'x', fingerprint: 'y' } },
    { permission: permissions.note.read, effect: 'allow', role: null, where: { op: 'eq', field: 'anything', value: 1 } },
    { permission: ghost, effect: 'allow', role: null, where: { op: 'eq', field: 'anything', value: 1 } },
  ],
};
`;

describe('conditions on undeclared fields', () => {
  it('walks every operator and skips resources without a declared schema', async () => {
    const cwd = project({
      'src/permissions.ts': PERMISSIONS,
      'src/policy.ts': CONDITIONS,
    });
    const result = report((await usage(cwd)).output);
    expect(
      result.undeclared.map((item) => [item.key, item.detail.split(' reads ')]),
    ).toEqual(
      [
        ['policy grant', 'w1'],
        ['policy grant', 'w2'],
        ["role 'member'", 'w3'],
        ["role 'member'", 'w4'],
        ["role 'member'", 'w5'],
        ['policy grant', 'w6'],
        ['policy grant', 'w7'],
        ['policy grant', 'w8'],
        ['policy grant', 'w9'],
      ].map(([who, field]) => [
        'post.read',
        [who, `'${String(field)}', which the post schema does not declare`],
      ]),
    );
    expect(
      report((await usage(cwd, { ignore: ['post.read'] })).output).undeclared,
    ).toEqual([]);
  });
});

const POLICY = policyModule(`  roles: [role('member', [
    allow(permissions.post.read, { where: { title2: 'x' } }),
    allow(permissions.post.list),
  ])],`);

const UI = `'use client';
import { usePermission } from 'permdock/react';
import { permissions } from './permissions.ts';

export const a = () => usePermission(permissions.post.update);
export const b = () => usePermission(permissions.post.read);
export const snap = (permdock: never) => permdock.snapshot({ include: [permissions.post.read] });
`;

const SERVER = `import { role } from 'permdock';
import { permissions } from './permissions.ts';

export const orphan = role('orphan', []);
export const dynamic = (key: 'read') => can(permissions.post[key]);
export const list = can(permissions.post.list);
export const del = can(permissions.post.delete);
`;

describe('the usage report', () => {
  const files = {
    'src/permissions.ts': PERMISSIONS,
    'src/policy.ts': POLICY,
    'src/ui.tsx': UI,
    'src/server.ts': SERVER,
  };

  it('prints every section with counts', async () => {
    const cwd = project(files);
    const result = await usage(cwd, {
      json: false,
      ignore: [
        'note.*',
        'post.approve',
        'post.pay',
        'post.transfer',
        'post.create',
      ],
    });
    expect(result.code).toBe(1);
    expect(result.output).toBe(`permdock usage

  defined but unused (0)

  used but ungranted (2)
    post.delete                  src/server.ts:7 (can)
    post.update                  src/ui.tsx:5 (usePermission)

  granted by no role (1)
    orphan                       role 'orphan' not passed to definePolicy

  conditions on undeclared fields (1)
    post.read                    role 'member' reads 'title2', which the post schema does not declare

  client checks outside include (1)
    post.update                  src/ui.tsx:5 (usePermission) is outside every snapshot include

  dynamic (1)
    src/server.ts:5 (can)

  5 warnings, 1 error
`);
  });

  it('lists unused leaves, honours --dynamic-as-used and --strict', async () => {
    const cwd = project({
      'src/permissions.ts': PERMISSIONS,
      'src/policy.ts': policyModule(
        `  roles: [role('member', [allow(permissions.post.read)])],`,
      ),
      'src/check.ts': `import { permissions } from './permissions.ts';\nexport const r = can(permissions.post.read);\n`,
    });
    const ignore = [
      'post.update',
      'post.delete',
      'post.approve',
      'post.pay',
      'post.transfer',
      'post.create',
      'post.list',
    ];
    const loose = await usage(cwd, { ignore });
    expect(report(loose.output).unused).toEqual([
      { kind: 'unused', key: 'note.read', detail: 'defined' },
    ]);
    expect(loose.code).toBe(0);
    expect((await usage(cwd, { ignore, strict: true })).code).toBe(1);
    const dynamic = await usage(cwd, {
      ignore,
      dynamicAsUsed: true,
      strict: true,
    });
    expect(report(dynamic.output).unused).toEqual([]);
    expect(dynamic.code).toBe(0);
    const human = await usage(cwd, { ignore, json: false });
    expect(human.output).toContain('  1 warning, 0 errors\n');
    expect(human.output).not.toContain('dynamic (');
  });

  it('skips the include check when a snapshot site has no literal include', async () => {
    const cwd = project({
      ...files,
      'src/all.ts': `export const all = (permdock: never, options: never) => permdock.snapshot(options);\n`,
    });
    expect(report((await usage(cwd)).output).outsideInclude).toEqual([]);
  });

  it('treats doctor.clientEntries as client files', async () => {
    const cwd = project({
      'src/permissions.ts': PERMISSIONS,
      'src/policy.ts': POLICY,
      'src/entry.ts': `import { permissions } from './permissions.ts';\nexport const c = (permdock: never) => [permdock.snapshot({ include: [permissions.post.read] }), can(permissions.post.list), can(permissions.post.list)];\n`,
      'src/server.ts': `import { permissions } from './permissions.ts';\nexport const d = can(permissions.post.list);\n`,
    });
    const run = async (clientEntries: readonly string[]) =>
      report(
        (
          await usage(cwd, {
            config: { ...CONFIG, doctor: { clientEntries } },
          })
        ).output,
      ).outsideInclude.map((item) => item.detail);
    expect(await run([])).toEqual([]);
    expect(await run(['src/entry.ts'])).toEqual([
      'src/entry.ts:2 (can) is outside every snapshot include',
    ]);
  });
});
