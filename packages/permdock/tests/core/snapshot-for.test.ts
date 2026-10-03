import { describe, expect, it } from 'vitest';

import {
  createPermDock,
  fromSnapshot,
  mayAccess,
  parseSnapshot,
  snapshotFor,
} from '../../src/index.ts';
import {
  alice,
  bob,
  otherProject,
  ownProject,
  permissions,
  policy,
} from '../fixtures/saas.ts';

function assertJson(value: unknown, path = '$'): void {
  if (
    value === null ||
    ['string', 'number', 'boolean'].includes(typeof value)
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJson(item, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} is a ${typeof value}`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${path} is not a plain object`);
  }
  for (const [key, item] of Object.entries(value)) {
    assertJson(item, `${path}.${key}`);
  }
}

describe('snapshotFor', () => {
  it('matches createPermDock().snapshot() for the same subject', async () => {
    const permdock = await createPermDock(policy, alice, { tenant: 'acme' });
    // SAFETY: the instance has no signer, so snapshot() returned an unsigned Snapshot.
    const expected = permdock.snapshot() as { readonly issuedAt: number };
    const actual = snapshotFor(policy, alice, {
      tenant: 'acme',
      now: expected.issuedAt,
    });
    expect(actual).toEqual(expected);
  });

  it('is plain JSON that survives structuredClone and JSON', () => {
    const snapshot = snapshotFor(policy, alice, { tenant: 'acme', now: 100 });
    assertJson(snapshot);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    const parsed = parseSnapshot(JSON.stringify(snapshot));
    const client = fromSnapshot(parsed);
    expect(client.can(permissions.project.update, otherProject)).toBe(true);
  });

  it('scopes to the requested tenant only when the subject is a member', () => {
    const acme = fromSnapshot(snapshotFor(policy, alice, { tenant: 'acme' }));
    const globex = fromSnapshot(
      snapshotFor(policy, alice, { tenant: 'globex' }),
    );
    const stranger = snapshotFor(policy, alice, { tenant: 'initech' });
    expect(acme.can(permissions.member.invite)).toBe(true);
    expect(globex.can(permissions.member.invite)).toBe(false);
    expect(globex.can(permissions.project.list)).toBe(true);
    expect(stranger.tenants).toEqual([]);
    expect(stranger.subject.principal?.tenant).toBeUndefined();
    expect(fromSnapshot(stranger).can(permissions.project.list)).toBe(false);
  });

  it('evaluates row conditions on the client from the snapshot', () => {
    const client = fromSnapshot(snapshotFor(policy, bob, { tenant: 'acme' }));
    expect(client.can(permissions.project.update, ownProject)).toBe(true);
    expect(client.can(permissions.project.update, otherProject)).toBe(false);
    expect(
      client.can(permissions.project.delete, { ...ownProject, archived: true }),
    ).toBe(false);
  });

  it('applies the tenant plans and custom roles passed from a shared cache', () => {
    const free = fromSnapshot(
      snapshotFor(policy, alice, { tenant: 'acme', plans: ['free'] }),
    );
    const pro = fromSnapshot(
      snapshotFor(policy, alice, { tenant: 'acme', plans: ['pro'] }),
    );
    expect(free.can(permissions.audit.read)).toBe(false);
    expect(pro.can(permissions.audit.read)).toBe(true);

    const lead = {
      id: 'lee',
      memberships: [{ tenant: 'acme', roles: ['lead'] }],
    };
    const customRoles = [
      { tenant: 'acme', name: 'lead', includes: ['admin'] },
      { tenant: 'globex', name: 'lead', includes: ['owner'] },
    ];
    const withLead = fromSnapshot(
      snapshotFor(policy, lead, { tenant: 'acme', customRoles }),
    );
    expect(withLead.can(permissions.member.invite)).toBe(true);
    expect(withLead.can(permissions.billing.manage)).toBe(false);
    expect(
      fromSnapshot(snapshotFor(policy, lead, { tenant: 'acme' })).can(
        permissions.member.invite,
      ),
    ).toBe(false);
  });

  it('replaces claim memberships in database mode', () => {
    const demoted = fromSnapshot(
      snapshotFor(policy, alice, {
        tenant: 'acme',
        memberships: [{ tenant: 'acme', roles: ['viewer'] }],
      }),
    );
    expect(demoted.can(permissions.member.invite)).toBe(false);
    expect(demoted.can(permissions.project.list)).toBe(true);
  });

  it('takes the clock from the caller and copies the subject expiry', () => {
    const snapshot = snapshotFor(
      policy,
      {
        principal: { id: 'bob', memberships: bob.memberships ?? [] },
        context: {},
        expiresAt: 5000,
      },
      { tenant: 'acme', now: 1234.9 },
    );
    expect(snapshot.issuedAt).toBe(1234);
    expect(snapshot.expiresAt).toBe(5000);
  });

  it('builds an anonymous snapshot for a null user', () => {
    const snapshot = snapshotFor(policy, null);
    expect(snapshot.subject.principal).toBeNull();
    expect(snapshot.grants.filter((grant) => grant.effect === 'allow')).toEqual(
      [],
    );
  });

  it('rejects async mappers instead of returning a promise', () => {
    // SAFETY: deliberately an async context mapper, which snapshotFor must refuse.
    const asyncPolicy = {
      ...policy,
      context: async () => ({}),
    } as unknown as typeof policy;
    expect(() => snapshotFor(asyncPolicy, alice)).toThrow(TypeError);
  });
});

describe('mayAccess', () => {
  it('is false only when declared roles provably lack the permission', () => {
    expect(
      mayAccess(policy, alice, permissions.member.invite, { tenant: 'acme' }),
    ).toBe(true);
    expect(
      mayAccess(policy, alice, permissions.member.invite, { tenant: 'globex' }),
    ).toBe(false);
    expect(
      mayAccess(policy, bob, permissions.billing.manage, { tenant: 'acme' }),
    ).toBe(false);
    expect(mayAccess(policy, null, permissions.project.list)).toBe(false);
  });

  it('is optimistic about row conditions, plans and custom roles', () => {
    expect(
      mayAccess(policy, bob, permissions.project.update, { tenant: 'acme' }),
    ).toBe(true);
    expect(
      mayAccess(policy, alice, permissions.audit.read, { tenant: 'acme' }),
    ).toBe(true);
    const custom = {
      id: 'lee',
      memberships: [{ tenant: 'acme', roles: ['lead'] }],
    };
    expect(
      mayAccess(policy, custom, permissions.billing.manage, { tenant: 'acme' }),
    ).toBe(true);
  });

  it('is optimistic when the claims carry no memberships (database mode)', () => {
    expect(
      mayAccess(policy, { id: 'dana' }, permissions.member.invite, {
        tenant: 'acme',
      }),
    ).toBe(true);
  });
});
