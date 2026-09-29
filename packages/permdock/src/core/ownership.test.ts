import { describe, expect, it } from 'vitest';

import type { RoleChange } from './ownership.ts';
import type { PermDock } from './permdock.ts';
import type { Principal } from './subject.ts';

import {
  customRoles,
  documents,
  permissions,
  personas,
  policy,
} from '../fixtures/named-scopes.ts';
import { fromSnapshot } from './from-snapshot.ts';
import { memoryRoleSource } from './interfaces.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, role } from './policy.ts';

async function dockFor(
  principal: Principal,
  tenant?: string,
): Promise<PermDock> {
  return createPermDock(policy, principal, {
    customRoles: memoryRoleSource(customRoles),
    ...(tenant === undefined ? {} : { tenant }),
  });
}

const staffTarget = { id: 'u_new', via: 'staff', roles: [] };

function reasons(decision: ReturnType<PermDock['decideRoleChange']>) {
  return decision.outcome === 'denied'
    ? decision.denials.map((denial) => denial.reason)
    : [];
}

describe('ownership: role options', () => {
  const tree = definePermissions({
    doc: resource({
      actions: ['read'],
      relations: { org: { field: 'org_id', memberOf: 'org' } },
    }),
  });
  const scopes = { org: { key: 'org_id' } } as const;
  const subject = (user: Principal | null) => user;

  it('rejects holder counts on a role without a named scope', () => {
    expect(() => role('root', [allow(tree.doc.read)], { min: 1 })).toThrow(
      /need on: '<scope>'/,
    );
    expect(() =>
      role('root', [allow(tree.doc.read)], { transferOnly: true }),
    ).toThrow(/need on: '<scope>'/);
  });

  it('rejects malformed counts and lists', () => {
    expect(() => role('owner', [], { on: 'org', min: 2, max: 1 })).toThrow(
      /min must not exceed max/,
    );
    expect(() => role('owner', [], { on: 'org', max: 0 })).toThrow(
      /max must be at least 1/,
    );
    expect(() => role('owner', [], { on: 'org', min: 1.5 })).toThrow(
      /whole number/,
    );
    expect(() =>
      role('owner', [], { on: 'org', assigns: ['__proto__'] }),
    ).toThrow(/list of names/);
  });

  it('rejects an assigns entry naming an undeclared role', () => {
    expect(() =>
      definePolicy(tree, {
        scopes,
        subject,
        roles: [role('owner', [], { on: 'org', assigns: ['ghost'] })],
      }),
    ).toThrow(/undeclared role 'ghost'/);
  });

  it('keeps the options on the binding', () => {
    const owner = role('owner', [allow(tree.doc.read)], {
      on: 'org',
      min: 1,
      max: 3,
      transferOnly: true,
      assigns: ['owner'],
      for: ['staff'],
      meta: { audience: 'staff' },
    });
    expect(owner).toMatchObject({
      min: 1,
      max: 3,
      transferOnly: true,
      assigns: ['owner'],
      for: ['staff'],
      meta: { audience: 'staff' },
    });
    expect(() => role('owner', [], { on: 'org', min: 0 })).not.toThrow();
  });
});

describe('ownership: membership kinds', () => {
  it('drops a staff role held through a contact membership', async () => {
    const dock = await dockFor({
      id: 'u_sneaky',
      tenant: 'T',
      memberships: [
        { scope: 'organization', id: 'T', roles: ['admin'], via: 'contact' },
      ],
    });
    expect(dock.can(permissions.quote.read, documents[0])).toBe(false);
    expect(dock.memberships()[0]?.roles).toEqual([]);
    expect(dock.heldRoles()).toEqual([]);
  });

  it('drops a role with for when the membership names no kind', async () => {
    const dock = await dockFor({
      id: 'u_bare',
      tenant: 'T',
      memberships: [{ scope: 'organization', id: 'T', roles: ['owner'] }],
    });
    expect(dock.can(permissions.quote.read, documents[0])).toBe(false);
  });

  it('drops the contact role on a staff membership', async () => {
    const dock = await dockFor({
      id: 'u_staff',
      tenant: 'T',
      memberships: [
        {
          scope: 'customer',
          id: 'A',
          within: { organization: 'T' },
          roles: ['contact'],
          via: 'staff',
        },
      ],
    });
    expect(dock.can(permissions.quote.read, documents[0])).toBe(false);
  });

  it('applies kinds to a simulated preview', async () => {
    const owner = await dockFor(personas.owner);
    const preview = owner.simulate({
      memberships: [
        { scope: 'organization', id: 'T', roles: ['owner'], via: 'guest' },
      ],
    });
    expect(preview.can(permissions.quote.read, documents[0])).toBe(false);
  });

  it('drops a resource role held through a kind its for omits', async () => {
    const tree = definePermissions({
      folder: resource({ actions: ['read'] }),
    });
    const shared = definePolicy(tree, {
      subject: (user: Principal | null) => user,
      roles: [
        role('editor', [allow(tree.folder.read)], {
          on: tree.folder,
          for: ['staff'],
        }),
      ],
    });
    const holding = (via?: string) =>
      createPermDock(shared, {
        id: 'u_1',
        memberships: [
          {
            on: { resource: 'folder', id: 'f_1' },
            roles: ['editor'],
            ...(via === undefined ? {} : { via }),
          },
        ],
      });
    const row = { id: 'f_1' };
    expect((await holding('staff')).can(tree.folder.read, row)).toBe(true);
    expect((await holding('link')).can(tree.folder.read, row)).toBe(false);
    expect((await holding()).can(tree.folder.read, row)).toBe(false);
  });
});

describe('ownership: decideRoleChange (CentraKit assertion 8)', () => {
  const inT = (change: Partial<RoleChange>): RoleChange => ({
    kind: 'assign',
    role: 'member',
    scope: 'organization',
    id: 'T',
    target: staffTarget,
    holders: 1,
    ...change,
  });

  it('lets an owner assign owner and denies an admin', async () => {
    const owner = await dockFor(personas.owner);
    const admin = await dockFor(personas.admin);
    const change = inT({ role: 'owner' });
    expect(owner.decideRoleChange(change)).toMatchObject({
      outcome: 'granted',
      role: 'owner',
    });
    expect(reasons(admin.decideRoleChange(change))).toEqual([
      'not-assignable-by',
    ]);
    expect(admin.decideRoleChange(inT({ role: 'viewer' }))).toMatchObject({
      outcome: 'granted',
      role: 'admin',
    });
  });

  it('offers an admin only the roles its assigns lists, in rank order', async () => {
    const owner = await dockFor(personas.owner);
    const admin = await dockFor(personas.admin);
    expect(owner.assignableRoles().map((leaf) => leaf.key)).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
      'contact',
    ]);
    expect(admin.assignableRoles().map((leaf) => leaf.key)).toEqual([
      'member',
      'viewer',
      'contact',
    ]);
  });

  it('keeps the last owner and allows removing one of two', async () => {
    const owner = await dockFor(personas.owner);
    const other = { id: 'u_other', via: 'staff', roles: ['owner'] };
    expect(
      reasons(
        owner.decideRoleChange(
          inT({ kind: 'revoke', role: 'owner', target: other, holders: 1 }),
        ),
      ),
    ).toEqual(['last-holder']);
    expect(
      owner.decideRoleChange(
        inT({ kind: 'revoke', role: 'owner', target: other, holders: 2 }),
      ).outcome,
    ).toBe('granted');
  });

  it('denies a count rule when the holder count is unknown', async () => {
    const owner = await dockFor(personas.owner);
    const decision = owner.decideRoleChange({
      kind: 'revoke',
      role: 'owner',
      scope: 'organization',
      id: 'T',
      target: { id: 'u_other', via: 'staff', roles: ['owner'] },
    });
    expect(decision).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'last-holder', detail: { holders: null } }],
    });
  });

  it('refuses self-demotion and passes a transfer', async () => {
    const owner = await dockFor(personas.owner);
    const admin = await dockFor(personas.admin);
    const self = { id: 'u_owner', via: 'staff', roles: ['owner'] };
    expect(
      reasons(
        owner.decideRoleChange(
          inT({ kind: 'revoke', role: 'owner', target: self, holders: 2 }),
        ),
      ),
    ).toEqual(['self-demotion']);
    const transfer = inT({
      kind: 'transfer',
      role: 'owner',
      target: { id: 'u_admin', via: 'staff', roles: ['admin'] },
    });
    expect(owner.decideRoleChange(transfer)).toMatchObject({
      outcome: 'granted',
      role: 'owner',
    });
    expect(
      reasons(admin.decideRoleChange({ ...transfer, target: staffTarget })),
    ).toEqual(['not-assignable-by']);
  });

  it('refuses to change a membership the identity provider owns', async () => {
    const owner = await dockFor(personas.owner);
    const managed = {
      id: 'u_admin',
      via: 'staff',
      roles: ['member'],
      managedBy: 'idp',
    } as const;
    expect(
      owner.decideRoleChange(
        inT({ kind: 'assign', role: 'admin', target: managed }),
      ),
    ).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'externally-managed' }],
    });
    expect(
      reasons(
        owner.decideRoleChange(
          inT({ kind: 'revoke', role: 'member', target: managed, holders: 3 }),
        ),
      ),
    ).toEqual(['externally-managed']);
  });

  it('keeps the contact role off staff memberships and admin off contacts', async () => {
    const owner = await dockFor(personas.owner);
    const contact = owner.decideRoleChange({
      kind: 'assign',
      role: 'contact',
      scope: 'customer',
      id: 'A',
      within: { organization: 'T' },
      target: staffTarget,
    });
    expect(reasons(contact)).toEqual(['not-allowed-for-membership']);
    const admin = owner.decideRoleChange(
      inT({ role: 'admin', target: { id: 'u_c', via: 'contact', roles: [] } }),
    );
    expect(reasons(admin)).toEqual(['not-allowed-for-membership']);
  });

  it('lets an organization admin assign a customer role through within', async () => {
    const admin = await dockFor(personas.admin);
    const change: RoleChange = {
      kind: 'assign',
      role: roles().contact,
      scope: 'customer',
      id: 'A',
      within: { organization: 'T' },
      target: { id: 'u_c', via: 'contact', roles: [] },
    };
    expect(admin.decideRoleChange(change)).toMatchObject({
      outcome: 'granted',
      role: 'admin',
    });
    const { within: _, ...bare } = change;
    expect(reasons(admin.decideRoleChange(bare))).toEqual([
      'not-assignable-by',
    ]);
  });

  it('denies anonymous callers, unknown roles and the wrong scope', async () => {
    const anonymous = await createPermDock(policy, null);
    const owner = await dockFor(personas.owner);
    expect(reasons(anonymous.decideRoleChange(inT({})))).toEqual(['anonymous']);
    expect(reasons(owner.decideRoleChange(inT({ role: 'ghost' })))).toEqual([
      'unknown-role',
    ]);
    expect(reasons(owner.decideRoleChange(inT({ role: 'contact' })))).toEqual([
      'scope',
    ]);
    expect(
      reasons(owner.decideRoleChange({ ...inT({}), target: { id: '' } })),
    ).toEqual(['validation']);
  });

  it('is a server decision: the snapshot client denies it', async () => {
    const owner = await dockFor(personas.owner);
    const snapshot = owner.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError('expected an unsigned snapshot');
    }
    expect(reasons(fromSnapshot(snapshot).decideRoleChange(inT({})))).toEqual([
      'unsupported',
    ]);
  });
});

function roles() {
  return policy.vocabulary.roles;
}

describe('ownership: max, transferOnly and exclusiveWith', () => {
  const tree = definePermissions({
    payment: resource({
      actions: ['create', 'approve'],
      relations: { org: { field: 'org_id', memberOf: 'org' } },
    }),
  });
  const strict = definePolicy(tree, {
    scopes: { org: { key: 'org_id' } },
    subject: (user: Principal | null) => user,
    roles: [
      role('primary', [allow(tree.payment.approve)], {
        on: 'org',
        min: 1,
        max: 1,
        transferOnly: true,
        assigns: ['primary', 'creator', 'approver'],
      }),
      role('creator', [allow(tree.payment.create)], {
        on: 'org',
        exclusiveWith: ['approver'],
      }),
      role('approver', [allow(tree.payment.approve)], { on: 'org' }),
    ],
  });
  const primary: Principal = {
    id: 'u_primary',
    tenant: 'o1',
    memberships: [{ scope: 'org', id: 'o1', roles: ['primary'] }],
  };
  const change = (extra: Partial<RoleChange>): RoleChange => ({
    kind: 'assign',
    role: 'primary',
    scope: 'org',
    id: 'o1',
    target: { id: 'u_next', roles: [] },
    holders: 1,
    ...extra,
  });

  it('caps holders and only moves a transfer-only role by transfer', async () => {
    const dock = await createPermDock(strict, primary);
    expect(reasons(dock.decideRoleChange(change({})))).toEqual([
      'max-holders',
      'transfer-only',
    ]);
    expect(dock.decideRoleChange(change({ holders: 0 })).outcome).toBe(
      'granted',
    );
    expect(dock.decideRoleChange(change({ kind: 'transfer' })).outcome).toBe(
      'granted',
    );
  });

  it('refuses a role the target cannot hold alongside one it has', async () => {
    const dock = await createPermDock(strict, primary);
    const decision = dock.decideRoleChange(
      change({ role: 'approver', target: { id: 'u_c', roles: ['creator'] } }),
    );
    expect(decision).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'conflicting-role', detail: { with: ['creator'] } }],
    });
  });
});

describe('ownership: rank and audiences', () => {
  it('orders held roles by the assigns graph', async () => {
    const dock = await dockFor({
      id: 'u_both',
      tenant: 'T',
      memberships: [
        {
          scope: 'organization',
          id: 'T',
          roles: ['viewer', 'owner'],
          via: 'staff',
        },
      ],
    });
    expect(dock.heldRoles().map((leaf) => leaf.key)).toEqual([
      'owner',
      'viewer',
    ]);
  });

  it('narrows held roles to one scope and instance', async () => {
    const dock = await dockFor(personas.staffContact);
    expect(
      dock.heldRoles({ scope: 'customer' }).map((leaf) => leaf.key),
    ).toEqual(['contact']);
    expect(
      dock
        .heldRoles({ scope: 'organization', id: 'B' })
        .map((leaf) => leaf.key),
    ).toEqual([]);
    expect(dock.heldRoles({ scope: 'nowhere' })).toEqual([]);
  });

  it('lists the audiences of the active tenant, in the snapshot too', async () => {
    const inT = await dockFor(personas.staffContact);
    const inB = inT.tenant('B');
    expect(inT.audiences()).toEqual(['staff']);
    expect(inB.audiences()).toEqual(['portal']);
    expect((await dockFor(personas.platformAdmin)).audiences()).toEqual([
      'platform',
    ]);
    const snapshot = inB.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError('expected an unsigned snapshot');
    }
    expect(snapshot.audiences).toEqual(['portal']);
    expect(fromSnapshot(snapshot).audiences()).toEqual(['portal']);
    const bare = (await dockFor(personas.mechanic)).snapshot();
    expect(bare).not.toHaveProperty('audiences');
  });
});
