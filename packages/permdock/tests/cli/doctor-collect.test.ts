import { afterAll, describe, expect, it } from 'vitest';

import type { DoctorFinding } from '../../src/cli/doctor-types.ts';
import type { PermDockConfig } from '../../src/cli/types.ts';

import {
  pd002,
  pd003,
  pd004,
  pd016,
  pd017,
  pd018,
  pd019,
  pd020,
  pd021,
  pd023,
  pd024,
  pd025,
  pd026,
  pd027,
  pd029,
  pd030,
  pd031,
  pd032,
  pd033,
  pd034,
  pd035,
  pd037,
} from '../../src/cli/doctor-collect.ts';
import { pd044 } from '../../src/cli/doctor-next.ts';
import {
  NOW,
  PERMISSIONS,
  policyProject,
  project,
  quietIo,
  removeProjects,
} from './doctor-kit.ts';

afterAll(removeProjects);

type Check = (input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}) => Promise<readonly DoctorFinding[]> | readonly DoctorFinding[];

const withRuntime =
  (
    check: (input: {
      readonly cwd: string;
      readonly config: PermDockConfig;
      readonly now: Date;
      readonly io: typeof quietIo;
      readonly env: Readonly<Record<string, string | undefined>>;
    }) => Promise<readonly DoctorFinding[]>,
  ): Check =>
  (input) =>
    check({ ...input, now: NOW, io: quietIo, env: {} });

const POLICY_CHECKS: Readonly<Record<string, Check>> = {
  PD003: withRuntime(pd003),
  PD016: pd016,
  PD017: pd017,
  PD018: pd018,
  PD019: pd019,
  PD020: pd020,
  PD021: withRuntime(pd021),
  PD023: pd023,
  PD024: pd024,
  PD025: pd025,
  PD026: pd026,
  PD027: pd027,
  PD029: pd029,
  PD030: pd030,
  PD031: pd031,
  PD032: pd032,
  PD033: pd033,
  PD034: pd034,
  PD035: pd035,
  PD037: pd037,
  PD044: withRuntime(pd044),
};

function messages(findings: readonly DoctorFinding[]): readonly string[] {
  return findings.map((item) => item.message);
}

describe('doctor checks that read the policy', () => {
  const cwd = project({
    'src/permissions.ts': PERMISSIONS,
    'src/not-policy.ts': 'export const policy = { nope: true };\n',
    'memberships.json': JSON.stringify({ memberships: [] }),
    'credentials.json': JSON.stringify({ credentials: [] }),
    'supabase/config.toml': '[auth]\njwt_expiry = 7200\n',
  });
  const reach = {
    rls: { authorize: 'jwt' },
    doctor: {
      memberships: './memberships.json',
      credentials: './credentials.json',
    },
  } as const;

  it.each(Object.entries(POLICY_CHECKS))(
    '%s reports nothing without a policy or with one that does not load',
    async (_code, check) => {
      expect(await check({ cwd, config: {} })).toEqual([]);
      expect(
        await check({ cwd, config: { ...reach, policy: './src/missing.ts' } }),
      ).toEqual([]);
      expect(
        await check({
          cwd,
          config: { ...reach, policy: './src/not-policy.ts' },
        }),
      ).toEqual([]);
    },
  );
});

describe('PD002, PD003 and PD004 read the collected catalog', () => {
  it('PD002 names an unknown permission and is silent without a permissions module', async () => {
    const cwd = policyProject(
      {},
      {
        'src/check.ts': `import { permissions } from './permissions.ts';\nexport const x = can(permissions.post.nope);\n`,
      },
    );
    expect(
      messages(await pd002({ cwd, config: {}, now: NOW, io: quietIo })),
    ).toEqual(['unknown permission can:post.nope at src/check.ts:2']);
    expect(
      await pd002({
        cwd,
        config: { permissions: './src/missing.ts' },
        now: NOW,
        io: quietIo,
      }),
    ).toEqual([]);
  });

  it('PD003 names a used permission no grant gives', async () => {
    const cwd = policyProject(
      { policy: `  roles: [role('member', [allow(permissions.post.read)])],` },
      {
        'src/check.ts': `import { permissions } from './permissions.ts';\nexport const a = can(permissions.post.read);\nexport const b = can(permissions.post.update);\n`,
      },
    );
    const findings = await pd003({
      cwd,
      config: { policy: './src/policy.ts' },
      now: NOW,
      io: quietIo,
    });
    expect(findings).toEqual([
      {
        code: 'PD003',
        severity: 'warning',
        message: 'post.update is used but never granted (src/check.ts:3 (can))',
        fix: 'add an allow() with a to: selector, or a role() binding, in definePolicy',
      },
    ]);
  });

  it('PD004 is silent on a fresh catalog and without a permissions module', async () => {
    const cwd = policyProject({});
    expect(
      await pd004({ cwd, config: {}, now: NOW, io: quietIo }),
    ).toHaveLength(1);
    expect(
      await pd004({
        cwd,
        config: { permissions: './src/missing.ts' },
        now: NOW,
        io: quietIo,
      }),
    ).toEqual([]);
    await pd002({ cwd, config: {}, now: NOW, io: quietIo });
    expect(await pd004({ cwd, config: {}, now: NOW, io: quietIo })).toEqual([]);
  });
});

describe('PD016 and PD027 under an rls config', () => {
  it('PD016 reads opaque checks and accepts sqlFunction fixtures', async () => {
    const cwd = policyProject(
      {
        policy: `  roles: [role('member', [
    allow(permissions.post.update, { check: opaque({ sql: 'ok(id)', fingerprint: 'x' }) }),
    allow(permissions.post.read, { check: sqlFunction('job_permitted', { args: [{ field: 'id' }], twin: { authorId: principal.id } }) }),
  ])],`,
      },
      { 'fixtures/rls.json': '{}' },
    );
    const config = {
      policy: './src/policy.ts',
      rls: { fixtures: './fixtures/rls.json' },
    };
    expect(messages(await pd016({ cwd, config }))).toEqual([
      'policy has opaque RLS conditions that deny in memory',
    ]);
    expect(
      messages(await pd016({ cwd, config: { ...config, rls: {} } })),
    ).toEqual([
      'policy has opaque RLS conditions that deny in memory',
      'sqlFunction grants have no rls fixtures for verify --db',
    ]);
  });

  it('PD027 names a policy-level grant without a role', async () => {
    const cwd = policyProject({
      policy: `  grants: [allow(permissions.post.read, { to: authenticated(), check: { orgId: context.org } })],`,
    });
    expect(
      messages(
        await pd027({ cwd, config: { policy: './src/policy.ts', rls: {} } }),
      ),
    ).toEqual([expect.stringMatching(/^post\.read reads context\.org: /u)]);
  });
});

describe('PD017 sensitive verbs', () => {
  it('skips denies, other verbs, approvals, denied leaves and repeats', async () => {
    const cwd = policyProject({
      policy: `  roles: [
    role('a', [
      allow(permissions.post.approve),
      allow(permissions.post.read),
      allow(permissions.post.pay, { approval: 'human' }),
      allow(permissions.post.transfer),
      deny(permissions.post.transfer),
    ]),
    role('b', [allow(permissions.post.approve)]),
  ],`,
    });
    const config = { policy: './src/policy.ts' };
    expect(messages(await pd017({ cwd, config }))).toEqual([
      'post.approve is a sensitive verb without approval',
    ]);
    expect(
      messages(
        await pd017({
          cwd,
          config: { ...config, doctor: { sensitiveActions: ['read'] } },
        }),
      ),
    ).toEqual(['post.read is a sensitive verb without approval']);
  });
});

describe('PD024 self-approval', () => {
  it('names a policy-level grant without a role', async () => {
    const cwd = policyProject({
      policy: `  grants: [allow(permissions.post.pay, { to: authenticated(), approval: { distinct: false } })],`,
    });
    expect(
      messages(await pd024({ cwd, config: { policy: './src/policy.ts' } })),
    ).toEqual([
      'post.pay sets approval.distinct: false, so the requester can approve their own request',
    ]);
  });
});

describe('PD018 separation of duties', () => {
  const policy = `  roles: [
    role('preparer', [allow(permissions.post.read)], { exclusiveWith: ['approver'] }),
    role('approver', [allow(permissions.post.approve)]),
  ],`;

  it('warns on a missing or unparsable fixture', async () => {
    const cwd = policyProject({ policy }, { 'bad.json': '{', 'num.json': '5' });
    const run = async (memberships: string) =>
      messages(
        await pd018({
          cwd,
          config: { policy: './src/policy.ts', doctor: { memberships } },
        }),
      );
    expect(await run('./absent.json')).toEqual([
      'doctor.memberships fixture ./absent.json is missing',
    ]);
    expect(await run('./bad.json')).toEqual([
      'doctor.memberships fixture ./bad.json is not valid JSON',
    ]);
    expect(await run('./num.json')).toEqual([]);
  });

  it('names a membership without a principal as unknown and reads a custom role without includes', async () => {
    const cwd = policyProject(
      { policy },
      {
        'memberships.json': JSON.stringify({
          customRoles: [{ tenant: 'o1', name: 'empty' }],
          memberships: [{ roles: ['preparer', 'approver'] }],
        }),
      },
    );
    expect(
      messages(
        await pd018({
          cwd,
          config: {
            policy: './src/policy.ts',
            doctor: { memberships: './memberships.json' },
          },
        }),
      ),
    ).toEqual([
      'membership unknown holds exclusive roles approver and preparer',
    ]);
  });
});

describe('PD020 and PD021 hostable permissions', () => {
  it('PD020 only names hostable permissions on tables rls compiles', async () => {
    const cwd = policyProject({
      policy: `  roles: [role('member', [allow(permissions.post.read)])],
  hostable: [permissions.post.read],`,
      plain: `  roles: [role('member', [allow(permissions.post.read)])],`,
    });
    const config = (tables: Readonly<Record<string, string>>) => ({
      policy: './src/policy.ts',
      rls: { tables },
    });
    expect(await pd020({ cwd, config: config({ note: 'notes' }) })).toEqual([]);
    expect(
      messages(await pd020({ cwd, config: config({ post: 'posts' }) })),
    ).toEqual([
      'hostable permissions are also compiled into RLS, which never sees hosted grants: post.read',
    ]);
    expect(
      await pd020({ cwd, config: { policy: './src/plain.ts', rls: {} } }),
    ).toEqual([]);
    expect(
      await pd021({ cwd, config: { policy: './src/plain.ts' }, env: {} }),
    ).toEqual([]);
  });
});

describe('PD019 JWT roles outliving a revocation', () => {
  const policy = `  roles: [role('clerk', [allow(permissions.post.approve)])],`;

  it('reads [auth] jwt_expiry, the default sensitive verbs and rls.authorize', async () => {
    const config = {
      policy: './src/policy.ts',
      rls: { authorize: 'jwt' },
    } as const;
    const long = policyProject(
      {
        policy,
        quiet: `  roles: [role('reader', [allow(permissions.post.read)])],`,
      },
      {
        'supabase/config.toml':
          '[api]\njwt_expiry = 9000\n\n[auth]\nsite_url = "x"\njwt_expiry = 7200\n',
      },
    );
    expect(messages(await pd019({ cwd: long, config }))).toEqual([
      'the RLS helpers and authorize() read roles from the JWT and jwt_expiry is 7200s: a revoked role keeps post.approve until the token expires',
    ]);
    expect(
      await pd019({
        cwd: long,
        config: { ...config, policy: './src/quiet.ts' },
      }),
    ).toEqual([]);
    expect(
      await pd019({ cwd: long, config: { policy: './src/policy.ts' } }),
    ).toEqual([]);

    const noFile = policyProject({ policy });
    expect(await pd019({ cwd: noFile, config })).toEqual([]);
    const otherSection = policyProject(
      { policy },
      { 'supabase/config.toml': '[api]\njwt_expiry = 9000\n' },
    );
    expect(await pd019({ cwd: otherSection, config })).toEqual([]);
  });
});

describe('PD023 custom roles', () => {
  const policy = `  scopes: { tenant: { key: 'orgId' } },
  roles: [role('viewer', [allow(permissions.post.read)], { on: 'tenant' })],`;

  it('drops a grant that carries a condition', async () => {
    const cwd = policyProject(
      { policy },
      {
        'memberships.json': JSON.stringify({
          customRoles: [
            {
              tenant: 'o1',
              name: 'narrow',
              grants: [{ permission: 'post.read', where: { orgId: 'o1' } }],
            },
          ],
        }),
        'empty.json': '{}',
        'bad.json': '{',
      },
    );
    const run = async (memberships: string) =>
      pd023({
        cwd,
        config: { policy: './src/policy.ts', doctor: { memberships } },
      });
    expect(await run('./memberships.json')).toEqual([
      {
        code: 'PD023',
        severity: 'warning',
        message:
          'custom role narrow in o1 drops permission post.read (condition-not-allowed)',
        fix: 'remove the condition; custom-role grants inherit the declared grant condition',
      },
    ]);
    expect(await run('./empty.json')).toEqual([]);
    expect(await run('./bad.json')).toEqual([]);
    expect(await run('./absent.json')).toEqual([]);
  });
});

describe('PD029 credential fixtures', () => {
  it('ignores fixtures that are missing, unparsable or not objects', () => {
    const cwd = project({
      'bad.json': '{',
      'text.json': '"text"',
      'shapes.json': JSON.stringify({
        credentials: 'none',
        settings: { acme: null, globex: { credentials: { maxTtl: 60 } } },
      }),
      'flat.json': JSON.stringify({ settings: 'all' }),
    });
    for (const credentials of [
      './absent.json',
      './bad.json',
      './text.json',
      './shapes.json',
      './flat.json',
    ]) {
      expect({
        credentials,
        findings: pd029({ cwd, config: { doctor: { credentials } } }),
      }).toEqual({ credentials, findings: [] });
    }
  });
});

describe('PD025 scoped memberships', () => {
  const policy = `  scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId', within: 'tenant' } },
  roles: [role('viewer', [allow(permissions.post.read)], { on: 'tenant' })],`;

  it('names a membership without a principal by its index', async () => {
    const cwd = policyProject(
      { policy },
      {
        'memberships.json': JSON.stringify({
          memberships: [
            { scope: 'tenant', id: 'o1', roles: ['viewer'] },
            { scope: 'team', id: 't1', roles: ['viewer'] },
          ],
        }),
        'empty.json': '{}',
        'bad.json': '{',
      },
    );
    const run = async (memberships: string) =>
      messages(
        await pd025({
          cwd,
          config: { policy: './src/policy.ts', doctor: { memberships } },
        }),
      );
    expect(await run('./memberships.json')).toEqual([
      expect.stringMatching(
        /^membership 1 grants nothing: its scope is not one of tenant, team/u,
      ),
    ]);
    expect(await run('./empty.json')).toEqual([]);
    expect(await run('./bad.json')).toEqual([]);
    expect(await run('./absent.json')).toEqual([]);
  });
});

describe('PD030 field-limited reads', () => {
  const policy = `  roles: [role('member', [
    allow(permissions.post.read, { fields: ['id', 'title'] }),
    allow(permissions.post.list, { fields: ['id', 'authorId', 'orgId', 'title', 'secret'] }),
    allow(permissions.post.update, { fields: ['title'] }),
    allow(permissions.note.read, { fields: ['title'] }),
    deny(permissions.note.read, { fields: ['secret'] }),
  ])],`;

  it('names row-level tables, then views without revoked columns', async () => {
    const cwd = policyProject({
      policy,
      covered: `  roles: [role('member', [allow(permissions.post.list, { fields: ['id', 'authorId', 'orgId', 'title', 'secret'] })])],`,
    });
    const run = async (rls: NonNullable<PermDockConfig['rls']>) =>
      messages(
        await pd030({ cwd, config: { policy: './src/policy.ts', rls } }),
      );
    expect(await run({})).toEqual([
      'read grants on note limit secret, but RLS on note is row-level: any client that reads note directly gets those columns',
      'read grants on post limit authorId, orgId, secret, but RLS on post is row-level: any client that reads post directly gets those columns',
    ]);
    expect(await run({ fields: 'views', tables: { post: 'posts' } })).toEqual([
      'note_visible masks secret, but note still returns them to a direct read',
      'posts_visible masks authorId, orgId, secret, but posts still returns them to a direct read',
    ]);
    expect(await run({ fields: 'views', revokeColumns: true })).toEqual([]);
    expect(
      await pd030({ cwd, config: { policy: './src/covered.ts', rls: {} } }),
    ).toEqual([]);
  });
});

const GRAPH = `import { allow, definePermissions, definePolicy, relation, resource } from 'permdock';

export const permissions = definePermissions({
  folder: resource({
    actions: ['read'],
    parent: { field: 'parentId', resource: 'folder' },
    relations: { lead: { edge: 'folder_leads' } },
  }),
  doc: resource({
    actions: ['read'],
    parent: { field: 'folderId', resource: 'folder' },
    restricted: 'restricted',
  }),
  Upper: resource({
    actions: ['read'],
    parent: { field: 'parentId', resource: 'Upper' },
    relations: { lead: { edge: 'upper_leads' } },
  }),
});

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.folder.read, {
      to: relation(permissions.folder, 'lead', { through: 'parent' }),
    }),
    allow(permissions.Upper.read, {
      to: relation(permissions.Upper, 'lead', { through: 'parent' }),
    }),
  ],
  subject: () => null,
});
`;

describe('PD031 and PD032 graph declarations', () => {
  it('accepts a walked self-parent and a restricted child its parent graph reaches', async () => {
    const cwd = project({ 'src/graph.ts': GRAPH });
    expect(await pd031({ cwd, config: { policy: './src/graph.ts' } })).toEqual(
      [],
    );
  });

  it('PD032 errors on a graph resource that is not a lowercase SQL name', async () => {
    const cwd = project({ 'src/graph.ts': GRAPH });
    expect(
      await pd032({ cwd, config: { policy: './src/graph.ts', rls: {} } }),
    ).toEqual([
      {
        code: 'PD032',
        severity: 'error',
        message:
          'graph resource Upper is not a lowercase SQL name, so rls generate cannot name permitted_Upper_ids',
        fix: 'rename the resource to lowercase letters, digits and underscores',
      },
    ]);
  });
});

describe('PD033 role activation', () => {
  const policy = `  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('admin', [allow(permissions.post.update)], { on: 'tenant', activation: { maxDuration: '4h' } }),
    role('member', [allow(permissions.post.read)], { on: 'tenant' }),
  ],`;

  it('warns when a fixture holds an activation role standing, never when it is eligible', async () => {
    const cwd = policyProject(
      { policy },
      {
        'standing.json': JSON.stringify({
          memberships: [
            { principal: 'u1', tenant: 'o1', roles: ['admin'] },
            { principal: 'u2', tenant: 'o1' },
          ],
        }),
        'eligible.json': JSON.stringify({
          memberships: [
            {
              principal: 'u1',
              tenant: 'o1',
              roles: ['member'],
              eligible: ['admin'],
            },
          ],
        }),
        'bad.json': '{',
      },
    );
    const run = async (memberships?: string) =>
      messages(
        await pd033({
          cwd,
          config: {
            policy: './src/policy.ts',
            ...(memberships === undefined ? {} : { doctor: { memberships } }),
          },
        }),
      );
    expect(await run('./standing.json')).toEqual([
      "activation role 'admin' is held standing by a fixture membership: an eligible-only role must never be held directly",
    ]);
    expect(await run('./eligible.json')).toEqual([]);
    expect(await run('./bad.json')).toEqual([]);
    expect(await run('./absent.json')).toEqual([]);
    expect(await run()).toEqual([]);
  });
});

describe('PD034, PD035 and PD037 stay quiet on a clean policy', () => {
  it('reports nothing without break-glass, with actorRequired and without migrations', async () => {
    const cwd = policyProject({
      policy: `  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('member', [allow(permissions.post.read, { where: { authorId: principal.id } })], { on: 'tenant' }),
    supportAccess({ role: 'support', actorRequired: true, consent: { by: 'owner', durations: ['1d'] } }),
  ],`,
    });
    const config = { policy: './src/policy.ts', rls: {} };
    expect(await pd034({ cwd, config })).toEqual([]);
    expect(await pd035({ cwd, config })).toEqual([]);
    expect(await pd037({ cwd, config })).toEqual([]);
  });
});
