import { describe, expect, it } from 'vitest';

import { opaque } from '../conditions/opaque.ts';
import { principal } from '../conditions/refs.ts';
import { sqlFunction } from '../conditions/sql-function.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from './errors.ts';
import { memoryRoleSource } from './interfaces.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, role } from './policy.ts';
import { memorySink } from './sink.ts';
import { parseSnapshot } from './snapshot.ts';

async function dock(
  user: Parameters<typeof createPermDock>[1],
  options?: Parameters<typeof createPermDock>[2],
) {
  return createPermDock(policy, user, options);
}

describe('createPermDock', () => {
  it('is synchronous for the quick-start policy', async () => {
    const created = createPermDock(policy, memberUser);
    expect(created).not.toBeInstanceOf(Promise);
    const permdock = await created;
    expect(permdock.can(permissions.post.read, ownPost)).toBe(true);
    expect(permdock.can(permissions.post.create)).toBe(true);
    expect(permdock.can(permissions.post.update, ownPost)).toBe(true);
    expect(permdock.can(permissions.post.update, otherPost)).toBe(false);
    expect(permdock.can(permissions.post.publish, ownPost)).toBe(false);
    const deniedPublish = permdock.decide(permissions.post.publish, ownPost);
    expect(deniedPublish.outcome).toBe('denied');
    if (deniedPublish.outcome === 'denied') {
      expect(deniedPublish.alternatives.length).toBeGreaterThan(0);
    }
    expect(permdock.where(permissions.post.publish).condition).toBeDefined();
  });

  it('grants admin publish unless already published', async () => {
    const permdock = await dock(adminUser);
    expect(permdock.can(permissions.post.publish, ownPost)).toBe(true);
    expect(permdock.can(permissions.post.publish, otherPost)).toBe(false);
    const portable = permdock.where(permissions.post.publish);
    expect(
      portable.condition.op === 'and' ||
        portable.condition.op === 'eq' ||
        portable.condition.op === 'or',
    ).toBe(true);
    expect(permdock.can(permissions.post.delete, otherPost)).toBe(true);
    expect(permdock.decide(permissions.post.delete, ownPost).outcome).toBe(
      'granted',
    );
  });

  it('returns approval-required for the member delete grant', async () => {
    const permdock = await dock(memberUser);
    const decision = permdock.decide(permissions.post.delete, ownPost);
    expect(decision.outcome).toBe('approval-required');
    if (decision.outcome === 'approval-required') {
      expect(decision.token.startsWith('pd1.')).toBe(true);
    }
    expect(() => permdock.assert(permissions.post.delete, ownPost)).toThrow(
      PermDockApprovalRequiredError,
    );
  });

  it('denies anonymous and unknown roles', async () => {
    const anonymous = await dock(null);
    expect(anonymous.can(permissions.post.read, ownPost)).toBe(false);
    const decision = anonymous.decide(permissions.post.read, ownPost);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('anonymous');
    }
    const unknown = await dock({ id: 'u3', orgId: 'o1', roles: ['ghost'] });
    expect(unknown.decide(permissions.post.read, ownPost).outcome).toBe(
      'denied',
    );
  });

  it('filters rows and emits one event with counts', async () => {
    const sink = memorySink();
    const permdock = await dock(memberUser, { sink });
    const rows = permdock.filter(permissions.post.update, [ownPost, otherPost]);
    expect(rows).toEqual([ownPost]);
    expect(sink.events()).toHaveLength(1);
    expect(sink.events()[0]?.counts).toEqual({
      granted: 1,
      denied: 1,
      approvalRequired: 0,
    });
  });

  it('simulates a batch and a preview instance', async () => {
    const permdock = await dock(memberUser);
    const batch = permdock.simulate([
      [permissions.post.update, ownPost],
      [permissions.post.publish, ownPost],
    ]);
    expect(Array.isArray(batch)).toBe(true);
    if (Array.isArray(batch)) {
      expect(batch.map((item) => item.outcome)).toEqual(['granted', 'denied']);
    }
    const preview = permdock.simulate({ roles: ['admin'] });
    if (Array.isArray(preview)) {
      throw new Error('expected instance');
    }
    expect(preview.can(permissions.post.publish, ownPost)).toBe(true);
    const snapshot = preview.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected json snapshot');
    }
    expect(snapshot.simulated).toBe(true);
  });

  it('builds snapshot v3 and parses it', async () => {
    const permdock = await dock(memberUser);
    const snapshot = permdock.snapshot({ include: [permissions.post] });
    if (snapshot instanceof Promise) {
      throw new Error('expected json snapshot');
    }
    expect(snapshot.v).toBe(3);
    expect(
      snapshot.grants.every((grant) => grant.permission.startsWith('post')),
    ).toBe(true);
    expect(parseSnapshot(JSON.stringify(snapshot)).v).toBe(3);
  });

  it('signs snapshots when a signer is passed', async () => {
    const permdock = await dock(memberUser);
    const signed = permdock.snapshot({
      signer: {
        async sign(payload, options) {
          expect(options.typ).toBe('permdock-snapshot+jwt');
          expect('snapshot' in payload).toBe(true);
          return 'signed.jws';
        },
      },
    });
    expect(await signed).toBe('signed.jws');
  });

  it('intersects GNAP access with principal grants', async () => {
    const covered = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['admin'] },
      context: {},
      delegation: {
        access: [
          {
            type: 'https://api.example.com/resources/post',
            actions: ['read', 'publish'],
            identifier: 'p1',
          },
        ],
      },
    });
    expect(covered.can(permissions.post.read, ownPost)).toBe(true);
    expect(covered.can(permissions.post.publish, ownPost)).toBe(true);
    const update = covered.decide(permissions.post.update, ownPost);
    expect(update.outcome).toBe('denied');
    if (update.outcome === 'denied') {
      expect(update.denials[0]?.reason).toBe('not-delegated');
    }
    const other = covered.decide(permissions.post.read, {
      ...ownPost,
      id: 'p9',
    });
    expect(other.outcome).toBe('denied');
    if (other.outcome === 'denied') {
      expect(other.denials[0]?.reason).toBe('not-delegated');
    }
    const stringRef = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['admin'] },
      context: {},
      delegation: { access: ['post:read'] },
    });
    expect(stringRef.can(permissions.post.read, ownPost)).toBe(true);
    expect(stringRef.can(permissions.post.publish, ownPost)).toBe(false);
    const emptyAccess = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['admin'] },
      context: {},
      delegation: { access: [] },
    });
    const denied = emptyAccess.decide(permissions.post.read, ownPost);
    expect(denied.outcome).toBe('denied');
    if (denied.outcome === 'denied') {
      expect(denied.denials[0]?.reason).toBe('no-delegation');
    }
  });

  it('intersects delegation scopes', async () => {
    const permdock = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['admin'] },
      context: {},
      delegation: { scopes: ['post:read'] },
    });
    expect(permdock.can(permissions.post.read, ownPost)).toBe(true);
    const denied = permdock.decide(permissions.post.publish, ownPost);
    expect(denied.outcome).toBe('denied');
    if (denied.outcome === 'denied') {
      expect(denied.denials[0]?.reason).toBe('not-delegated');
    }
  });

  it('treats a thenable closure as closure-error', async () => {
    const closurePolicy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(
            permissions.post.read,
            () => Promise.resolve(true) as unknown as boolean,
          ),
        ]),
      ],
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    const permdock = await createPermDock(closurePolicy, memberUser);
    const errors: unknown[] = [];
    permdock.on('error', (error) => {
      errors.push(error);
    });
    const decision = permdock.decide(permissions.post.read, ownPost);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('closure-error');
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not match a collection check grant without a body', async () => {
    const checked = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.post.create, { check: { authorId: principal.id } }),
        ]),
      ],
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    const permdock = await createPermDock(checked, memberUser);
    expect(permdock.can(permissions.post.create)).toBe(false);
    expect(
      permdock.can(permissions.post.create, { ...ownPost, authorId: 'u1' }),
    ).toBe(true);
  });

  it('resolves custom roles through memoryRoleSource', async () => {
    const permdock = await createPermDock(
      policy,
      {
        id: 'u4',
        orgId: 'o1',
        roles: ['staff'],
      },
      {
        customRoles: memoryRoleSource([
          { tenant: 'unused', name: 'staff', includes: ['member'] },
        ]),
      },
    );
    expect(permdock.can(permissions.post.read, ownPost)).toBe(false);
    const withMembership = await createPermDock(
      policy,
      {
        principal: {
          id: 'u4',
          roles: ['staff'],
          memberships: [{ tenant: 'o1', roles: ['staff'] }],
        },
        context: {},
      },
      {
        customRoles: memoryRoleSource([
          { tenant: 'o1', name: 'staff', includes: ['member'] },
        ]),
      },
    );
    expect(withMembership.can(permissions.post.read, ownPost)).toBe(true);
  });

  it('throws PermDockDeniedError from assert', async () => {
    const permdock = await dock(memberUser);
    expect(() => permdock.assert(permissions.post.publish, ownPost)).toThrow(
      PermDockDeniedError,
    );
  });

  it('returns where AST and marks closures partial', async () => {
    const permdock = await dock(memberUser);
    const portable = permdock.where(permissions.post.update);
    expect(portable.partial).toBe(false);
    expect(
      portable.condition.op === 'eq' || portable.condition.op === 'and',
    ).toBe(true);
  });

  it('opaque conditions deny with opaque-condition', async () => {
    const opaquePolicy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.post.read, {
            where: opaque({ sql: '1=1', fingerprint: 'x' }),
          }),
        ]),
      ],
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    const permdock = await createPermDock(opaquePolicy, memberUser);
    const decision = permdock.decide(permissions.post.read, ownPost);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('opaque-condition');
    }
  });

  it('sqlFunction grants evaluate and snapshot through the twin', async () => {
    const fnPolicy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.post.read, {
            where: sqlFunction('job_permitted', {
              args: [{ field: 'id' }],
              twin: { authorId: principal.id },
            }),
          }),
        ]),
      ],
      subject: (user: { readonly id: string } | null) =>
        user === null ? null : { id: user.id, roles: ['member'] },
    });
    const permdock = await createPermDock(fnPolicy, memberUser);
    expect(permdock.can(permissions.post.read, ownPost)).toBe(true);
    expect(permdock.can(permissions.post.read, otherPost)).toBe(false);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const grant = snapshot.grants.find(
      (item) => item.permission === 'post.read',
    );
    expect(grant?.portable).not.toBe(false);
    expect(grant?.where).toMatchObject({
      op: 'sqlFunction',
      name: 'job_permitted',
    });
  });

  it('derives tenant and team instances', async () => {
    const scoped = definePermissions({
      post: resource({
        actions: ['read'],
        collection: ['list'],
      }),
    });
    const scopedPolicy = definePolicy(scoped, {
      roles: [role('viewer', [allow(scoped.post.read)], { on: 'tenant' })],
      scopes: { tenant: { key: 'orgId' } },
      subject: () => ({
        id: 'u1',
        memberships: [{ tenant: 'o1', roles: ['viewer'] }],
      }),
    });
    const permdock = await createPermDock(
      scopedPolicy,
      { id: 'u1' },
      { tenant: 'o1' },
    );
    expect(permdock.tenants()).toEqual(['o1']);
    expect(
      permdock.tenant('o1').can(scoped.post.read, { id: 'p1', orgId: 'o1' }),
    ).toBe(true);
    expect(
      permdock.tenant('o2').can(scoped.post.read, { id: 'p1', orgId: 'o1' }),
    ).toBe(false);
  });
});
