import { describe, expect, it } from 'vitest';

import { PermDockDeniedError } from '../../src/core/errors.ts';
import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

describe('fromSnapshot', () => {
  it('answers the same portable checks as the server instance', async () => {
    const server = await createPermDock(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(true);
    expect(client.can(permissions.post.create)).toBe(true);
    expect(client.can(permissions.post.update, ownPost)).toBe(true);
    expect(client.can(permissions.post.update, otherPost)).toBe(false);
    expect(client.can(permissions.post.publish, ownPost)).toBe(false);
    expect(client.decide(permissions.post.delete, ownPost).outcome).toBe(
      'approval-required',
    );
    expect(
      client.filter(permissions.post.update, [ownPost, otherPost]),
    ).toEqual([ownPost]);
    expect(client.where(permissions.post.update).partial).toBe(false);
  });

  it('keeps deny-overrides-allow for admin publish', async () => {
    const server = await createPermDock(policy, adminUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.publish, ownPost)).toBe(true);
    expect(client.can(permissions.post.publish, otherPost)).toBe(false);
    expect(client.decide(permissions.post.publish, otherPost).outcome).toBe(
      'denied',
    );
  });

  it('fails closed for anonymous and unknown include', async () => {
    const server = await createPermDock(policy, null);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(false);
    expect(client.decide(permissions.post.read, ownPost).outcome).toBe(
      'denied',
    );
  });

  it('treats portable false and include misses as server-only denials', async () => {
    const server = await createPermDock(policy, memberUser);
    const full = server.snapshot();
    if (full instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const scoped = fromSnapshot({ ...full, include: ['billing'] });
    const decision = scoped.decide(permissions.post.update, ownPost);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('opaque-condition');
    }
    const opaque = fromSnapshot({
      ...full,
      grants: full.grants.map((grant) => {
        if (grant.permission !== 'post.update') {
          return grant;
        }
        return {
          permission: grant.permission,
          effect: grant.effect,
          role: grant.role,
          to: grant.to,
          portable: false as const,
        };
      }),
    });
    const closed = opaque.decide(permissions.post.update, ownPost);
    expect(closed.outcome).toBe('denied');
    if (closed.outcome === 'denied') {
      expect(closed.denials[0]?.reason).toBe('opaque-condition');
    }
  });

  it('throws the same assert errors as the server', async () => {
    const server = await createPermDock(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(() => client.assert(permissions.post.publish, ownPost)).toThrow(
      PermDockDeniedError,
    );
  });

  it('exposes snapshot tenants and derived tenant instances', async () => {
    const server = await createPermDock(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(client.tenants()).toEqual(snapshot.tenants);
    expect(client.memberships()).toEqual(
      snapshot.subject.principal?.memberships ?? [],
    );
    expect(client.heldRoles().some((item) => item.key === 'member')).toBe(true);
    expect(client.assignableRoles()).toEqual([]);
    const other = client.tenant('missing');
    expect(other.subject.principal?.tenant).toBeUndefined();
  });

  it('intersects GNAP access on the snapshot subject', async () => {
    const server = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['admin'] },
      context: {},
      delegation: {
        access: [{ type: 'post', actions: ['read'], identifier: 'p1' }],
      },
    });
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(true);
    expect(client.can(permissions.post.publish, ownPost)).toBe(false);
  });
});
