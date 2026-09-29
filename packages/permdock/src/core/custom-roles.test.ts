import { describe, expect, it } from 'vitest';

import type { CustomRole, Membership } from './subject.ts';

import { principal } from '../conditions/refs.ts';
import {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from './custom-roles.ts';
import { fromSnapshot } from './from-snapshot.ts';
import { memoryRoleSource } from './interfaces.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, listPermissions, resource } from './permissions.ts';
import { allow, definePolicy, deny, role } from './policy.ts';
import { snapshotFor } from './snapshot-for.ts';
import { defineRoles } from './vocabulary.ts';

const permissions = definePermissions({
  invoice: resource({
    id: 'id',
    actions: ['read', 'pay', 'refund', 'void'],
    collection: ['create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  post: resource({
    id: 'id',
    actions: ['read', 'update', 'archive'],
    collection: ['create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  member: resource({
    collection: { invite: {}, assignRole: { manageRoles: true } },
  }),
  board: resource({
    id: 'id',
    actions: ['read', 'edit'],
    relations: {
      org: { field: 'orgId', memberOf: 'tenant' },
      team: { field: 'teamId', memberOf: 'team' },
    },
  }),
});

const roles = defineRoles({
  owner: { on: 'tenant', assignable: false },
  admin: { on: 'tenant' },
  billing: { on: 'tenant' },
  editor: { on: 'tenant' },
  viewer: { on: 'tenant' },
  steward: { on: 'tenant', meta: { manageRoles: true } },
  lead: { on: 'team' },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId' } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.owner, [
        allow(permissions.invoice.void),
        allow(permissions.member.assignRole),
      ]),
      role(roles.admin, [
        allow(permissions.invoice.read),
        allow(permissions.post.read),
        allow(permissions.post.update),
        allow(permissions.post.create),
        allow(permissions.member.invite),
      ]),
      role(roles.billing, [
        allow(permissions.invoice.read),
        allow(permissions.invoice.pay, { approval: 'human' }),
        allow(permissions.invoice.refund),
        deny(permissions.invoice.refund, { where: { amount: { gt: 1000 } } }),
      ]),
      role(roles.editor, [
        allow(permissions.post.read),
        allow(permissions.post.create),
        allow(permissions.post.update, { where: { authorId: principal.id } }),
      ]),
      role(roles.viewer, [
        allow(permissions.post.read),
        allow(permissions.invoice.read),
      ]),
      role(roles.steward, []),
      role(roles.lead, [
        allow(permissions.board.read),
        allow(permissions.board.edit),
      ]),
    ],
  },
);

const invoice = { id: 'i1', orgId: 'acme', amount: 50 };
const bigInvoice = { id: 'i2', orgId: 'acme', amount: 5000 };
const foreignInvoice = { id: 'i3', orgId: 'globex', amount: 50 };
const ownPost = { id: 'p1', orgId: 'acme', authorId: 'u1' };
const otherPost = { id: 'p2', orgId: 'acme', authorId: 'u9' };
const board = { id: 'b1', orgId: 'acme', teamId: 't1' };
const otherBoard = { id: 'b2', orgId: 'acme', teamId: 't2' };

function subjectIn(memberships: readonly Membership[], tenant = 'acme') {
  return {
    principal: { id: 'u1', memberships, tenant },
    context: {},
  };
}

async function dockFor(
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[],
  tenant = 'acme',
) {
  return createPermDock(policy, subjectIn(memberships, tenant), {
    tenant,
    customRoles: memoryRoleSource(customRoles),
  });
}

describe('resolveCustomRole', () => {
  it('unions includes and own allows, removes denies, within the ceiling', () => {
    const resolved = resolveCustomRole(policy, {
      tenant: 'acme',
      name: 'accounts',
      includes: ['billing'],
      grants: [
        { permission: 'post.read' },
        { permission: 'invoice.refund', effect: 'deny' },
      ],
    });
    const keys = resolved.grants.map(
      (grant) => `${grant.effect}:${grant.permission.key}`,
    );
    expect(keys).toContain('allow:invoice.read');
    expect(keys).toContain('allow:invoice.pay');
    expect(keys).toContain('allow:post.read');
    expect(keys).not.toContain('allow:invoice.refund');
    expect(keys).toContain('deny:invoice.refund');
    expect(resolved.dropped).toEqual([]);
    for (const grant of resolved.grants) {
      expect(grant.role).toBe('accounts');
      expect(grant.scope).toBe('tenant');
    }
    const pay = resolved.grants.find(
      (grant) => grant.permission.key === 'invoice.pay',
    );
    expect(pay?.approval).toBe('human');
  });

  it('reports every dropped entry with its reason', () => {
    const resolved = resolveCustomRole(policy, {
      tenant: 'acme',
      name: 'grabby',
      includes: ['owner', 'ghost'],
      grants: [
        { permission: 'invoice.void' },
        { permission: 'nope.read' },
        {
          permission: 'post.update',
          where: { authorId: 'x' },
        } as unknown as { permission: string },
      ],
    });
    expect(resolved.dropped).toEqual([
      { permission: 'invoice.void', reason: 'outside-ceiling' },
      { permission: 'member.assignRole', reason: 'outside-ceiling' },
      { role: 'ghost', reason: 'unknown-role' },
      { permission: 'nope.read', reason: 'unknown-permission' },
      { permission: 'post.update', reason: 'condition-not-allowed' },
    ]);
    expect(resolved.grants).toEqual([]);
  });

  it('validateCustomRole lists the effective permissions', () => {
    expect(
      validateCustomRole(policy, {
        tenant: 'acme',
        name: 'reader',
        grants: [{ permission: 'post.read' }, { permission: 'invoice.read' }],
      }),
    ).toEqual({
      ok: true,
      permissions: ['invoice.read', 'post.read'],
      dropped: [],
    });
    expect(
      validateCustomRole(policy, {
        tenant: 'acme',
        name: 'x',
        grants: [{ permission: 'invoice.void' }],
      }).ok,
    ).toBe(false);
  });

  it('keeps only the included denies of its own scope', () => {
    const resolved = resolveCustomRole(policy, {
      tenant: 'acme',
      team: 't1',
      name: 'team-billing',
      includes: ['billing', 'lead'],
    });
    expect(resolved.grants.map((grant) => grant.permission.key)).toEqual([
      'board.read',
      'board.edit',
    ]);
  });

  it('customRoleClaim writes the compact grants map', () => {
    expect(
      customRoleClaim([
        {
          tenant: 'acme',
          name: 'clerk',
          includes: ['billing'],
          grants: [
            { permission: 'post.read' },
            { permission: 'invoice.refund', effect: 'deny' },
          ],
        },
        { tenant: 'acme', name: '__proto__', grants: [] },
      ]),
    ).toEqual({ clerk: ['@billing', 'post.read', '-invoice.refund'] });
  });

  it('bounds a team custom role by the team ceiling', () => {
    const resolved = resolveCustomRole(policy, {
      tenant: 'acme',
      team: 't1',
      name: 'reviewer',
      grants: [{ permission: 'board.read' }, { permission: 'post.read' }],
    });
    expect(resolved.grants.map((grant) => grant.permission.key)).toEqual([
      'board.read',
    ]);
    expect(resolved.grants[0]?.scope).toBe('team');
    expect(resolved.dropped).toEqual([
      { permission: 'post.read', reason: 'outside-ceiling' },
    ]);
  });
});

describe('custom roles in decisions', () => {
  it('inherits the declared condition of an included role', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', roles: ['writer'] }],
      [{ tenant: 'acme', name: 'writer', includes: ['editor'] }],
    );
    expect(dock.can(permissions.post.update, ownPost)).toBe(true);
    expect(dock.can(permissions.post.update, otherPost)).toBe(false);
  });

  it('an own allow reaches every ceiling grant of the permission', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', roles: ['moderator'] }],
      [
        {
          tenant: 'acme',
          name: 'moderator',
          grants: [{ permission: 'post.update' }],
        },
      ],
    );
    expect(dock.can(permissions.post.update, otherPost)).toBe(true);
    const decision = dock.decide(permissions.post.update, otherPost);
    expect(decision.outcome === 'granted' && decision.matched.role).toBe(
      'moderator',
    );
  });

  it('keeps the declared deny of the role a grant comes from', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', roles: ['refunds'] }],
      [
        {
          tenant: 'acme',
          name: 'refunds',
          grants: [{ permission: 'invoice.refund' }],
        },
      ],
    );
    expect(dock.can(permissions.invoice.refund, invoice)).toBe(true);
    expect(dock.decide(permissions.invoice.refund, bigInvoice)).toMatchObject({
      outcome: 'denied',
      denials: [{ role: 'refunds', reason: 'deny' }],
    });
  });

  it('an own deny removes the permission, including from includes', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', roles: ['clerk'] }],
      [
        {
          tenant: 'acme',
          name: 'clerk',
          includes: ['billing'],
          grants: [
            { permission: 'invoice.refund' },
            { permission: 'invoice.refund', effect: 'deny' },
          ],
        },
      ],
    );
    expect(dock.can(permissions.invoice.read, invoice)).toBe(true);
    expect(dock.can(permissions.invoice.refund, invoice)).toBe(false);
  });

  it('never applies outside its tenant or to a declared name', async () => {
    const custom: CustomRole[] = [
      {
        tenant: 'acme',
        name: 'payer',
        grants: [{ permission: 'invoice.pay' }],
      },
      { tenant: 'globex', name: 'payer', grants: [] },
      {
        tenant: 'acme',
        name: 'viewer',
        grants: [{ permission: 'post.update' }],
      },
    ];
    const memberships: Membership[] = [
      { tenant: 'acme', roles: ['payer', 'viewer'] },
      { tenant: 'globex', roles: ['payer'] },
    ];
    const acme = await dockFor(memberships, custom);
    expect(acme.decide(permissions.invoice.pay, invoice).outcome).toBe(
      'approval-required',
    );
    expect(acme.can(permissions.invoice.pay, foreignInvoice)).toBe(false);
    expect(acme.can(permissions.post.update, otherPost)).toBe(false);
    const globex = await dockFor(memberships, custom, 'globex');
    expect(globex.decide(permissions.invoice.pay, foreignInvoice).outcome).toBe(
      'denied',
    );
  });

  it('scopes a team custom role to its team', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', team: 't1', roles: ['reviewer'] }],
      [
        {
          tenant: 'acme',
          team: 't1',
          name: 'reviewer',
          grants: [{ permission: 'board.read' }],
        },
      ],
    );
    expect(dock.can(permissions.board.read, board)).toBe(true);
    expect(dock.can(permissions.board.read, otherBoard)).toBe(false);
    expect(dock.can(permissions.board.edit, board)).toBe(false);
  });
});

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('the ceiling', () => {
  it('no custom role grants beyond the assignable declared roles', async () => {
    const random = lcg(42);
    const leaves = listPermissions(permissions);
    const keys = [...leaves.map((leaf) => leaf.key), 'nope.read'];
    const names = ['owner', 'admin', 'billing', 'editor', 'viewer', 'lead'];
    const rows = [invoice, bigInvoice, ownPost, otherPost, board, undefined];
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)]!;
    const everyAssignable = await dockFor(
      [
        {
          tenant: 'acme',
          roles: ['admin', 'billing', 'editor', 'viewer', 'steward'],
        },
        { tenant: 'acme', team: 't1', roles: ['lead'] },
      ],
      [],
    );
    let reached = 0;
    for (let index = 0; index < 150; index += 1) {
      const team = random() < 0.2 ? 't1' : undefined;
      const custom: CustomRole = {
        tenant: 'acme',
        ...(team === undefined ? {} : { team }),
        name: `c${index}`,
        includes: names.filter(() => random() < 0.3),
        grants: keys
          .filter(() => random() < 0.3)
          .map((permission) =>
            random() < 0.2
              ? { permission, effect: 'deny' as const }
              : { permission },
          ),
      };
      const dock = await dockFor(
        [
          {
            tenant: 'acme',
            ...(team === undefined ? {} : { team }),
            roles: [custom.name],
          },
        ],
        [custom],
      );
      for (let check = 0; check < 12; check += 1) {
        const leaf = pick(leaves);
        const row = leaf.kind === 'collection' ? undefined : pick(rows);
        if (dock.decide(leaf, row).outcome !== 'denied') {
          reached += 1;
          expect(everyAssignable.decide(leaf, row).outcome).not.toBe('denied');
        }
      }
    }
    expect(reached).toBeGreaterThan(100);
  });
});

describe('assignable roles and permissions', () => {
  it('intersects the ceiling with what the subject holds', async () => {
    const dock = await dockFor([{ tenant: 'acme', roles: ['editor'] }], []);
    expect(dock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      'post.read',
      'post.update',
      'post.create',
    ]);
    expect(dock.assignableRoles().map((leaf) => leaf.key)).toEqual(['editor']);
  });

  it('counts custom-role grants as held', async () => {
    const dock = await dockFor(
      [{ tenant: 'acme', roles: ['reader'] }],
      [
        {
          tenant: 'acme',
          name: 'reader',
          grants: [{ permission: 'post.read' }, { permission: 'invoice.read' }],
        },
      ],
    );
    expect(dock.assignableRoles().map((leaf) => leaf.key)).toEqual(['viewer']);
  });

  it('manageRoles on a role lifts the intersection', async () => {
    const dock = await dockFor([{ tenant: 'acme', roles: ['steward'] }], []);
    expect(dock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      'admin',
      'billing',
      'editor',
      'viewer',
      'steward',
      'lead',
    ]);
    expect(dock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      'invoice.read',
      'invoice.pay',
      'invoice.refund',
      'post.read',
      'post.update',
      'post.create',
      'member.invite',
    ]);
  });

  it('a granted manageRoles permission lifts the intersection', async () => {
    const dock = await dockFor([{ tenant: 'acme', roles: ['owner'] }], []);
    expect(dock.assignablePermissions()).toHaveLength(7);
    expect(dock.assignableRoles().map((leaf) => leaf.key)).not.toContain(
      'owner',
    );
  });

  it('honours RoleSource.assignable per tenant', async () => {
    const source = {
      ...memoryRoleSource([]),
      assignable: async (tenant: string) =>
        tenant === 'acme' ? ['viewer', 'editor'] : [],
    };
    const dock = await createPermDock(
      policy,
      subjectIn([
        { tenant: 'acme', roles: ['steward'] },
        { tenant: 'globex', roles: ['steward'] },
      ]),
      { tenant: 'acme', customRoles: source },
    );
    expect(dock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      'editor',
      'viewer',
    ]);
    expect(dock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      'invoice.read',
      'post.read',
      'post.update',
      'post.create',
    ]);
    expect(dock.assignablePermissions({ tenant: 'globex' })).toEqual([]);
    expect(dock.assignableRoles({ tenant: 'globex' })).toEqual([]);
  });

  it('a throwing RoleSource.assignable assigns nothing', async () => {
    const auth: unknown[] = [];
    const dock = await createPermDock(
      policy,
      subjectIn([{ tenant: 'acme', roles: ['steward'] }]),
      {
        tenant: 'acme',
        customRoles: {
          rolesFor: () => [],
          assignable: () => {
            throw new Error('down');
          },
        },
      },
    );
    dock.on('auth', (event) => {
      auth.push(event);
    });
    expect(dock.assignableRoles()).toEqual([]);
    expect(dock.assignablePermissions()).toEqual([]);
    expect(auth).toEqual([{ reason: 'source-threw', source: 'customRoles' }]);
  });

  it('is empty for anonymous subjects and without a tenant', async () => {
    const anonymous = await createPermDock(policy, null);
    expect(anonymous.assignableRoles()).toEqual([]);
    expect(anonymous.assignablePermissions()).toEqual([]);
  });
});

describe('snapshot parity', () => {
  const fixtures: { readonly name: string; readonly custom: CustomRole }[] = [
    {
      name: 'includes',
      custom: { tenant: 'acme', name: 'c', includes: ['editor'] },
    },
    {
      name: 'own allow',
      custom: {
        tenant: 'acme',
        name: 'c',
        grants: [{ permission: 'post.update' }],
      },
    },
    {
      name: 'inherited deny',
      custom: {
        tenant: 'acme',
        name: 'c',
        grants: [{ permission: 'invoice.refund' }],
      },
    },
    {
      name: 'own deny',
      custom: {
        tenant: 'acme',
        name: 'c',
        includes: ['billing', 'admin'],
        grants: [{ permission: 'invoice.pay', effect: 'deny' }],
      },
    },
    {
      name: 'outside ceiling',
      custom: {
        tenant: 'acme',
        name: 'c',
        includes: ['owner'],
        grants: [{ permission: 'invoice.void' }],
      },
    },
    {
      name: 'team',
      custom: {
        tenant: 'acme',
        team: 't1',
        name: 'c',
        grants: [{ permission: 'board.edit' }],
      },
    },
  ];
  const rows = [
    invoice,
    bigInvoice,
    foreignInvoice,
    ownPost,
    otherPost,
    board,
    otherBoard,
  ];

  for (const fixture of fixtures) {
    it(`decide and fromSnapshot agree: ${fixture.name}`, async () => {
      const membership: Membership =
        fixture.custom.team === undefined
          ? { tenant: 'acme', roles: ['c'] }
          : { tenant: 'acme', team: fixture.custom.team, roles: ['c'] };
      const server = await dockFor([membership], [fixture.custom]);
      const snapshot = server.snapshot();
      if (snapshot instanceof Promise) {
        throw new Error('expected JSON snapshot');
      }
      const cached = snapshotFor(policy, subjectIn([membership]), {
        tenant: 'acme',
        customRoles: [fixture.custom],
        now: snapshot.issuedAt,
      });
      expect(cached).toEqual(snapshot);
      const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
      for (const leaf of listPermissions(permissions)) {
        for (const row of leaf.kind === 'collection' ? [undefined] : rows) {
          expect(
            client.decide(leaf, row).outcome,
            `${leaf.key} ${JSON.stringify(row)}`,
          ).toBe(server.decide(leaf, row).outcome);
        }
      }
      expect(client.assignablePermissions().map((leaf) => leaf.key)).toEqual(
        server.assignablePermissions().map((leaf) => leaf.key),
      );
      expect(client.assignableRoles().map((leaf) => leaf.key)).toEqual(
        server.assignableRoles().map((leaf) => leaf.key),
      );
    });
  }

  it('include trims custom grants and assignable permissions', async () => {
    const server = await dockFor(
      [{ tenant: 'acme', roles: ['steward', 'c'] }],
      [{ tenant: 'acme', name: 'c', grants: [{ permission: 'invoice.read' }] }],
    );
    const snapshot = server.snapshot({ include: [permissions.post] });
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    expect(
      snapshot.grants.every((grant) => grant.permission.startsWith('post.')),
    ).toBe(true);
    expect(
      snapshot.assignable?.[0]?.permissions.map((leaf) => leaf.key),
    ).toEqual(['post.read', 'post.update', 'post.create']);
    const full = server.snapshot();
    if (full instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    expect(full.grants).toContainEqual(
      expect.objectContaining({
        permission: 'invoice.read',
        role: 'c',
        membership: { tenant: 'acme', roles: ['steward', 'c'] },
      }),
    );
  });
});
