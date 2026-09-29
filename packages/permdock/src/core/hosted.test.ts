import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PolicyDocument, PolicySource } from './hosted.ts';

import {
  isPortableCondition,
  memoryPolicySource,
  mergeHostedGrants,
  parsePolicyDocument,
} from './hosted.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, deny, role } from './policy.ts';
import { memorySink } from './sink.ts';
import { definePlans } from './vocabulary.ts';

const Invoice = z.object({
  id: z.string(),
  ownerId: z.string(),
  locked: z.boolean(),
});

const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'export'],
    relations: { owner: 'ownerId' },
  }),
  auditLog: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['read'],
  }),
});

const plans = definePlans({ pro: {}, free: {} });

type User = {
  readonly id: string;
  readonly roles: readonly string[];
  readonly plans?: readonly string[];
};

const policy = definePolicy(
  { permissions, plans },
  {
    roles: [
      role('member', [
        allow(permissions.invoice.read),
        allow(permissions.invoice.delete, { approval: 'human' }),
        deny(permissions.invoice.update, { where: { locked: true } }),
      ]),
      role('auditor', []),
    ],
    principal: (user: User) => user,
    hostable: [permissions.invoice, permissions.auditLog.read],
  },
);

const member: User = { id: 'u1', roles: ['member'] };
const proUser: User = { id: 'pro-user', roles: [], plans: ['pro'] };
const unlocked = { id: 'i1', ownerId: 'u1', locked: false };
const locked = { id: 'i2', ownerId: 'u1', locked: true };

function document(grants: readonly unknown[]): PolicyDocument {
  return parsePolicyDocument({
    v: 1,
    id: 'doc_1',
    fingerprint: 'fp_doc_1',
    catalog: 'cat_1',
    issuedAt: 1,
    grants,
  });
}

async function withDocument(
  user: User,
  grants: readonly unknown[],
): Promise<{
  readonly dock: Awaited<ReturnType<typeof createPermDock>>;
  readonly errors: unknown[];
}> {
  const dock = await createPermDock(policy, user, {
    policies: memoryPolicySource(document(grants)),
  });
  const errors: unknown[] = [];
  dock.on('error', (error) => {
    errors.push(error);
  });
  return { dock, errors };
}

describe('hosted grants', () => {
  it('ignores hosted grants without a policies source', async () => {
    const dock = await createPermDock(policy, proUser);
    expect(dock.can(permissions.auditLog.read, { id: 'a1' })).toBe(false);
  });

  it('merges a hosted plan grant on a hostable permission', async () => {
    const { dock, errors } = await withDocument(proUser, [
      {
        id: 'g_pro_audit',
        permission: 'auditLog.read',
        to: { kind: 'plan', plan: 'pro' },
      },
    ]);
    const decision = dock.decide(permissions.auditLog.read, { id: 'a1' });
    expect(decision.outcome).toBe('granted');
    expect(
      decision.outcome === 'granted' ? decision.matched.hosted : undefined,
    ).toEqual({ document: 'fp_doc_1', grant: 'g_pro_audit' });
    expect(errors).toEqual([]);
    const free = await withDocument(member, [
      {
        id: 'g_pro_audit',
        permission: 'auditLog.read',
        to: { kind: 'plan', plan: 'pro' },
      },
    ]);
    expect(free.dock.can(permissions.auditLog.read, { id: 'a1' })).toBe(false);
  });

  it('never overrides a code deny', async () => {
    const { dock } = await withDocument(member, [
      {
        id: 'g_update',
        permission: 'invoice.update',
        to: { kind: 'role', role: 'member', scope: 'global' },
      },
    ]);
    expect(dock.can(permissions.invoice.update, unlocked)).toBe(true);
    expect(dock.can(permissions.invoice.update, locked)).toBe(false);
  });

  it('applies a hosted deny', async () => {
    const { dock } = await withDocument(member, [
      {
        id: 'g_no_read_locked',
        permission: 'invoice.read',
        effect: 'deny',
        to: { kind: 'role', role: 'member', scope: 'global' },
        where: { op: 'eq', field: 'locked', value: true },
      },
    ]);
    expect(dock.can(permissions.invoice.read, unlocked)).toBe(true);
    expect(dock.can(permissions.invoice.read, locked)).toBe(false);
  });

  it('merges a relation grant with a portable condition', async () => {
    const { dock } = await withDocument({ id: 'u1', roles: [] }, [
      {
        id: 'g_owner_export',
        permission: 'invoice.export',
        to: { kind: 'relation', resource: 'invoice', relation: 'owner' },
        where: { op: 'eq', field: 'locked', value: false },
      },
    ]);
    expect(dock.can(permissions.invoice.export, unlocked)).toBe(true);
    expect(dock.can(permissions.invoice.export, locked)).toBe(false);
    expect(
      dock.can(permissions.invoice.export, { ...unlocked, ownerId: 'u9' }),
    ).toBe(false);
  });

  it('drops grants that break a rule and reports each through on(error)', async () => {
    const { dock, errors } = await withDocument(member, [
      {
        id: 'a',
        permission: 'invoice.nope',
        to: { kind: 'role', role: 'member', scope: 'global' },
      },
      {
        id: 'b',
        permission: 'invoice.read',
        to: { kind: 'role', role: 'ghost', scope: 'global' },
      },
      { id: 'c', permission: 'invoice.read', to: { kind: 'anyone' } },
      {
        id: 'd',
        permission: 'invoice.read',
        to: { kind: 'role', role: 'member', scope: 'global' },
        where: { op: 'opaque', sql: 'true', fingerprint: 'x' },
      },
      {
        id: 'e',
        permission: 'invoice.delete',
        to: { kind: 'role', role: 'auditor', scope: 'global' },
      },
      { id: 'f', to: { kind: 'plan', plan: 'pro' } },
      {
        id: 'g',
        permission: 'invoice.read',
        to: { kind: 'role', role: 'member', scope: 'global' },
        where: { op: 'eq', field: '__proto__.polluted', value: true },
      },
    ]);
    expect(
      errors.map((error) => (error as { readonly reason: string }).reason),
    ).toEqual([
      'unknown-permission',
      'unknown-grantee',
      'unknown-grantee',
      'non-portable',
      'weaker-approval',
      'invalid',
      'non-portable',
    ]);
    expect(dock.can(permissions.invoice.read, unlocked)).toBe(true);
  });

  it('drops a hosted approval that lets the requester approve a human grant', async () => {
    const { errors } = await withDocument(member, [
      {
        id: 'g_self',
        permission: 'invoice.delete',
        to: { kind: 'role', role: 'auditor', scope: 'global' },
        approval: { distinct: false },
      },
      {
        id: 'g_human',
        permission: 'invoice.delete',
        to: { kind: 'role', role: 'auditor', scope: 'global' },
        approval: 'human',
      },
    ]);
    expect(
      errors.map((error) => (error as { readonly reason: string }).reason),
    ).toEqual(['weaker-approval']);
  });

  it('drops a grant on a permission the policy does not mark hostable', () => {
    const narrow = definePolicy(permissions, {
      roles: [role('member', [])],
      principal: (user: User) => ({ id: user.id, roles: user.roles }),
      hostable: [permissions.auditLog.read],
    });
    const merged = mergeHostedGrants(
      narrow,
      document([
        {
          id: 'g',
          permission: 'invoice.read',
          to: { kind: 'role', role: 'member', scope: 'global' },
        },
      ]),
    );
    expect(merged.policy).toBe(narrow);
    expect(merged.dropped[0]?.reason).toBe('not-hostable');
  });

  it('keeps an approval at least as strict as the code grant', async () => {
    const { dock } = await withDocument({ id: 'u5', roles: ['auditor'] }, [
      {
        id: 'g_delete',
        permission: 'invoice.delete',
        to: { kind: 'role', role: 'auditor', scope: 'global' },
        approval: 'human',
      },
    ]);
    expect(dock.decide(permissions.invoice.delete, unlocked).outcome).toBe(
      'approval-required',
    );
  });

  it('binds approval tokens to the document', async () => {
    const plain = await createPermDock(policy, member);
    const { dock } = await withDocument(member, [
      {
        id: 'g_pro_audit',
        permission: 'auditLog.read',
        to: { kind: 'plan', plan: 'pro' },
      },
    ]);
    const before = plain.decide(permissions.invoice.delete, unlocked);
    const after = dock.decide(permissions.invoice.delete, unlocked);
    expect(before.outcome).toBe('approval-required');
    expect(after.outcome).toBe('approval-required');
    expect(before.outcome === 'approval-required' && before.token).not.toBe(
      after.outcome === 'approval-required' && after.token,
    );
  });

  it('reads current() once and treats a throwing source as absent', async () => {
    let reads = 0;
    const counting: PolicySource = {
      current: () => {
        reads += 1;
        return document([
          {
            id: 'g',
            permission: 'auditLog.read',
            to: { kind: 'plan', plan: 'pro' },
          },
        ]);
      },
      refresh: () => Promise.resolve(),
    };
    const dock = await createPermDock(policy, proUser, { policies: counting });
    dock.can(permissions.auditLog.read, { id: 'a' });
    dock.can(permissions.auditLog.read, { id: 'b' });
    expect(reads).toBe(1);
    const throwing: PolicySource = {
      current: () => {
        throw new Error('boom');
      },
      refresh: () => Promise.resolve(),
    };
    const fallback = await createPermDock(policy, proUser, {
      policies: throwing,
    });
    const errors: unknown[] = [];
    fallback.on('error', (error) => {
      errors.push(error);
    });
    expect(fallback.can(permissions.auditLog.read, { id: 'a' })).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('records the hosted grant on the decision event', async () => {
    const sink = memorySink();
    const dock = await createPermDock(policy, proUser, {
      sink,
      policies: memoryPolicySource(
        document([
          {
            id: 'g',
            permission: 'auditLog.read',
            to: { kind: 'plan', plan: 'pro' },
          },
        ]),
      ),
    });
    dock.decide(permissions.auditLog.read, { id: 'a' });
    const event = sink.events().find((item) => item.type === 'decision');
    expect(
      event?.type === 'decision' ? event.matched?.hosted : undefined,
    ).toEqual({ document: 'fp_doc_1', grant: 'g' });
  });

  it('rejects unknown document versions and unsafe keys', () => {
    expect(() => parsePolicyDocument({ v: 2 })).toThrow(/version/);
    expect(() =>
      parsePolicyDocument(
        '{"v":1,"id":"d","fingerprint":"f","catalog":"c","issuedAt":1,"grants":[{"__proto__":{}}]}',
      ),
    ).toThrow(/unsafe/);
  });

  it('recognises the portable subset only', () => {
    expect(
      isPortableCondition({
        op: 'eq',
        field: 'ownerId',
        value: { ref: 'principal.id' },
      }),
    ).toBe(true);
    expect(
      isPortableCondition({
        op: 'and',
        conditions: [
          { op: 'in', field: 'status', value: ['a', 'b'] },
          { op: 'not', condition: { op: 'isNull', field: 'x', value: true } },
        ],
      }),
    ).toBe(true);
    expect(
      isPortableCondition({ op: 'sqlFunction', name: 'f', args: [], twin: {} }),
    ).toBe(false);
    expect(
      isPortableCondition({
        op: 'eq',
        field: 'a',
        value: { ref: 'constructor.x' },
      }),
    ).toBe(false);
    expect(isPortableCondition({ op: 'regex', field: 'a', value: '.' })).toBe(
      false,
    );
  });
});
