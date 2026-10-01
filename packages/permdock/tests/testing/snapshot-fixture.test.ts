import { describe, expect, it } from 'vitest';

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { snapshotFixture } from '../../src/testing/snapshot-fixture.ts';

const permissions = definePermissions({
  doc: resource({ id: 'id', actions: ['read', 'update'] }),
});

const policy = definePolicy(permissions, {
  roles: [role('viewer', [allow(permissions.doc.read)])],
  subject: (user: { readonly id: string; readonly orgId: string } | null) =>
    user === null
      ? null
      : {
          id: user.id,
          roles: ['viewer'],
          memberships: [{ tenant: user.orgId, roles: [] }],
        },
});

const vera = { id: 'vera', orgId: 'o1' };

describe('snapshotFixture', () => {
  it('builds the default snapshot for the active tenant', async () => {
    const snapshot = await snapshotFixture(policy, vera, { tenant: 'o1' });
    expect({
      tenants: snapshot.tenants,
      grants: snapshot.grants.map((grant) => grant.permission),
    }).toEqual({ tenants: ['o1'], grants: ['doc.read'] });
  });

  it('passes include and tenants through', async () => {
    const included = await snapshotFixture(policy, vera, {
      tenant: 'o1',
      include: [permissions.doc.read],
    });
    const all = await snapshotFixture(policy, vera, { tenants: 'all' });
    expect({
      include: included.include,
      tenants: all.tenants,
    }).toEqual({ include: ['doc.read'], tenants: ['o1'] });
  });

  it('snapshots a simulated instance', async () => {
    const snapshot = await snapshotFixture(policy, vera, {
      tenant: 'o1',
      simulated: true,
    });
    expect(snapshot.v).toBe(1);
  });

  it('snapshots an anonymous subject with no grants', async () => {
    const snapshot = await snapshotFixture(policy, null);
    expect(snapshot.grants).toEqual([]);
  });
});
