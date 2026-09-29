import { describe, expect, it } from 'vitest';

import type { PermDock } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Membership, Principal } from './subject.ts';

import { pushedPolicy } from '../cli/cloud.ts';
import { evaluateCondition } from '../conditions/evaluate.ts';
import {
  assets,
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
import { parseSnapshot } from './snapshot.ts';

async function dockFor(
  principal: Principal,
  options: { readonly tenant?: string } = {},
): Promise<PermDock> {
  return createPermDock(policy, principal, {
    customRoles: memoryRoleSource(customRoles),
    ...options,
  });
}

const rowsFor = (permission: Permission): readonly object[] =>
  permission.resource === 'asset' ? assets : documents;

const instanceLeaves = [
  ...Object.values(permissions.quote),
  ...Object.values(permissions.invoice),
  ...Object.values(permissions.asset),
] as readonly Permission[];

function readable(dock: PermDock, permission: Permission): string[] {
  return rowsFor(permission)
    .filter((row) => dock.can(permission as never, row))
    .map((row) => (row as { readonly id: string }).id);
}

describe('named scopes: decide, snapshot and where agree', () => {
  for (const [name, principal] of Object.entries(personas)) {
    it(`agrees for ${name}`, async () => {
      const dock = await dockFor(principal);
      const snapshot = dock.snapshot();
      if (snapshot instanceof Promise) {
        throw new TypeError('expected an unsigned snapshot');
      }
      const client = fromSnapshot(parseSnapshot(JSON.stringify(snapshot)));
      for (const permission of instanceLeaves) {
        const where = dock.where(permission);
        for (const row of rowsFor(permission)) {
          const decided = dock.can(permission as never, row);
          expect(
            client.can(permission as never, row),
            `${name} snapshot ${permission.key} ${JSON.stringify(row)}`,
          ).toBe(decided);
          if (!where.partial) {
            expect(
              evaluateCondition(
                where.condition,
                row,
                dock.subject,
                undefined,
                where.scopes,
              ),
              `${name} where ${permission.key} ${JSON.stringify(row)}`,
            ).toBe(decided);
          }
        }
      }
    });
  }
});

describe('named scopes: the scenario', () => {
  it("shows a portal contact only their customer's sent documents", async () => {
    const dock = await dockFor(personas.privateContact);
    expect(readable(dock, permissions.quote.read)).toEqual([
      'd_a_sent',
      'd_a_accepted',
    ]);
    expect(readable(dock, permissions.quote.accept)).toEqual(['d_a_sent']);
    expect(readable(dock, permissions.quote.update)).toEqual([]);
    const business = await dockFor(personas.businessContact);
    expect(readable(business, permissions.invoice.read)).toEqual(['d_g_sent']);
  });

  it('gives an owner every quote of the active organization and no customer reach', async () => {
    const dock = await dockFor(personas.owner);
    expect(readable(dock, permissions.quote.read)).toEqual([
      'd_a_sent',
      'd_a_draft',
      'd_a_accepted',
      'd_g_sent',
    ]);
    expect(
      dock.memberships().filter((item) => item.scope === 'customer'),
    ).toEqual([]);
    const snapshot = dock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError('expected an unsigned snapshot');
    }
    expect(
      new Set(
        snapshot.grants
          .filter((grant) => grant.permission === 'quote.read')
          .map((grant) => grant.scope),
      ),
    ).toEqual(new Set(['organization']));
    expect(dock.where(permissions.quote.read).condition).toEqual({
      op: 'eq',
      field: 'organization_id',
      value: 'T',
    });
    expect(readable(dock.tenant('B'), permissions.quote.read)).toEqual([
      'd_c_sent',
      'd_b_draft',
    ]);
  });

  it('keeps a viewer to reading their own organization', async () => {
    const dock = await dockFor(personas.viewer);
    expect(readable(dock, permissions.quote.read)).toEqual([
      'd_c_sent',
      'd_b_draft',
    ]);
    expect(readable(dock, permissions.quote.update)).toEqual([]);
    expect(dock.tenant('T').can(permissions.quote.read, documents[0]!)).toBe(
      false,
    );
  });

  it('lets each membership of a staff member who is also a contact grant only in its own scope', async () => {
    const dock = await dockFor(personas.staffContact);
    expect(dock.subject.principal?.tenant).toBe('T');
    expect(dock.tenants()).toEqual(['T', 'B']);
    expect(readable(dock, permissions.quote.read)).toEqual([
      'd_a_sent',
      'd_a_draft',
      'd_a_accepted',
      'd_g_sent',
    ]);
    const portal = dock.tenant('B');
    expect(readable(portal, permissions.quote.read)).toEqual(['d_c_sent']);
    expect(readable(portal, permissions.quote.update)).toEqual([]);
    expect(portal.decide(permissions.quote.read, documents[5]!).outcome).toBe(
      'denied',
    );
  });

  it('gives platform operators system permissions and no tenant data', async () => {
    const admin = await dockFor(personas.platformAdmin);
    expect(admin.can(permissions.organization.disable, { id: 'T' })).toBe(true);
    expect(admin.can(permissions.organization.list)).toBe(true);
    for (const leaf of instanceLeaves) {
      expect(readable(admin, leaf)).toEqual([]);
    }
    expect(admin.where(permissions.quote.read).condition).toEqual({
      op: 'or',
      conditions: [],
    });
    const support = await dockFor(personas.platformSupport);
    expect(support.can(permissions.organization.disable, { id: 'T' })).toBe(
      false,
    );
  });

  it("applies org T's custom role and its tenant deny", async () => {
    const dock = await dockFor(personas.mechanic);
    expect(readable(dock, permissions.asset.update)).toEqual([
      'a_a_sent',
      'a_a_draft',
      'a_a_accepted',
      'a_g_sent',
    ]);
    expect(readable(dock, permissions.asset.delete)).toEqual([]);
    expect(readable(dock, permissions.quote.read)).toEqual([]);
  });

  it('blocks every path into a suspended organization through the membership source', async () => {
    const disabled = new Set(['T']);
    const active = (list: readonly Membership[] = []): Membership[] =>
      list.filter(
        (item) =>
          !disabled.has(item.scope === 'organization' ? (item.id ?? '') : '') &&
          !disabled.has(item.within?.organization ?? ''),
      );
    for (const principal of [
      personas.owner,
      personas.privateContact,
      personas.staffContact,
    ]) {
      const dock = await createPermDock(policy, principal, {
        memberships: {
          membershipsFor: () => active(principal.memberships),
        },
      });
      expect(readable(dock, permissions.quote.read)).toEqual([]);
      expect(dock.where(permissions.quote.read).condition).toEqual({
        op: 'or',
        conditions: [],
      });
    }
  });
});

describe('named scopes: snapshot scope list', () => {
  it('denies a scoped grant whose scope the snapshot does not list', async () => {
    const dock = await dockFor(personas.privateContact);
    const snapshot = dock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError('expected an unsigned snapshot');
    }
    const { scopes: _dropped, ...stripped } = snapshot;
    const client = fromSnapshot(parseSnapshot(JSON.stringify(stripped)));
    expect(client.can(permissions.quote.read, documents[0]!)).toBe(false);
    expect(client.where(permissions.quote.read).condition).toEqual({
      op: 'or',
      conditions: [],
    });
    expect(
      fromSnapshot(parseSnapshot(JSON.stringify(snapshot))).can(
        permissions.quote.read,
        documents[0]!,
      ),
    ).toBe(true);
  });

  it('pushes the scopes to the Cloud as a snapshot carries them', async () => {
    const dock = await dockFor(personas.owner);
    const snapshot = dock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError('expected an unsigned snapshot');
    }
    expect(pushedPolicy(policy).scopes).toEqual(snapshot.scopes);
    expect(pushedPolicy(policy).scopes?.[1]).toEqual({
      name: 'customer',
      key: 'customer_id',
      within: 'organization',
      resources: ['quote', 'invoice', 'asset'],
    });
  });
});

describe('named scopes: no implicit cascade', () => {
  it('never lets a customer membership satisfy an organization role, or the reverse', async () => {
    const crossed = await dockFor({
      id: 'u_x',
      tenant: 'T',
      memberships: [
        {
          scope: 'customer',
          id: 'A',
          within: { organization: 'T' },
          roles: ['owner'],
        },
        { scope: 'organization', id: 'T', roles: ['contact'] },
      ],
    });
    for (const leaf of instanceLeaves) {
      expect(readable(crossed, leaf)).toEqual([]);
    }
  });

  it('drops a nested membership without its parent id', async () => {
    const dock = await dockFor({
      id: 'u_x',
      tenant: 'T',
      memberships: [{ scope: 'customer', id: 'A', roles: ['contact'] }],
    });
    expect(dock.memberships()).toEqual([]);
  });

  it('accepts tenant and team aliases for the first two scopes', async () => {
    const dock = await dockFor({
      id: 'u_alias',
      tenant: 'T',
      memberships: [
        { tenant: 'T', team: 'A', roles: ['contact'], via: 'contact' },
        { tenant: 'T', roles: ['viewer'], via: 'staff' },
      ],
    });
    expect(dock.memberships()).toEqual([
      {
        scope: 'customer',
        id: 'A',
        within: { organization: 'T' },
        roles: ['contact'],
        via: 'contact',
      },
      { scope: 'organization', id: 'T', roles: ['viewer'], via: 'staff' },
    ]);
    const aliased = definePolicy(permissions, {
      scopes: {
        organization: { key: 'organization_id' },
        customer: { key: 'customer_id', within: 'organization' },
      },
      subject: (user: Principal | null) => user,
      roles: [role('reader', [allow(permissions.quote.read)], { on: 'team' })],
    });
    expect(aliased.grants[0]?.scope).toBe('customer');
  });
});

describe('named scopes: definition', () => {
  const tree = definePermissions({
    doc: resource({
      actions: ['read'],
      relations: { ws: { field: 'workspace_id', memberOf: 'workspace' } },
    }),
  });
  const subject = (user: Principal | null) => user;

  it('rejects a parent declared later, an unknown one and reserved names', () => {
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: {
          workspace: { key: 'workspace_id', within: 'organization' },
          organization: { key: 'organization_id' },
        },
      }),
    ).toThrow(/not declared before it/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { global: { key: 'x' } },
      }),
    ).toThrow(/scope name 'global'/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: 'o' }, tenant: { key: 't' } },
      }),
    ).toThrow(/'tenant' must be declared first/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId' } },
      }),
    ).toThrow(/scopes.team needs within/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: 'o' }, region: { key: 'r' } },
      }),
    ).toThrow(/scopes.region needs within/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: '' } },
      }),
    ).toThrow(/needs a key/);
  });

  it('requires the scope key on every resource an instance grant touches', () => {
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: 'organization_id' } },
        roles: [role('reader', [allow(tree.doc.read)], { on: 'organization' })],
      }),
    ).toThrow(/doc.read on 'organization' roles/);
    expect(
      definePolicy(tree, {
        subject,
        scopes: {
          organization: { key: 'organization_id' },
          workspace: { key: 'workspace_id', within: 'organization' },
        },
        roles: [role('reader', [allow(tree.doc.read)], { on: 'workspace' })],
      }).scopes.map((scope) => scope.name),
    ).toEqual(['organization', 'workspace']);
  });

  it('reserves the activation and restricted role options', () => {
    expect(() => role('x', [], { activation: undefined as never })).toThrow(
      /reserved/,
    );
    expect(() => role('x', [], { restricted: undefined as never })).toThrow(
      /reserved/,
    );
  });
});
