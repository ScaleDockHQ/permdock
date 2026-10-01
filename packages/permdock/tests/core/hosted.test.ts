import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PolicyDocument, PolicySource } from '../../src/core/hosted.ts';

import {
  isPortableCondition,
  memoryPolicySource,
  mergeHostedGrants,
  parsePolicyDocument,
} from '../../src/core/hosted.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { memorySink } from '../../src/core/sink.ts';
import { definePlans } from '../../src/core/vocabulary.ts';

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
    // SAFETY: every 'error' event for a rejected hosted grant carries a reason string.
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
    // SAFETY: every 'error' event for a rejected hosted grant carries a reason string.
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

describe('hosted approvals that go stale on a resource change', () => {
  const Filing = z.object({ id: z.string(), updatedAt: z.string() });
  const tree = definePermissions({
    filing: resource(Filing, {
      actions: ['pay', 'close'],
      version: 'updatedAt',
    }),
    note: resource(z.object({ id: z.string() }), { actions: ['pin'] }),
  });
  const versioned = definePolicy(tree, {
    roles: [
      role('clerk', [
        allow(tree.filing.pay, { approval: { staleOn: 'resource-change' } }),
      ]),
      role('auditor', []),
    ],
    principal: (user: User) => user,
    hostable: [tree.filing, tree.note],
  });

  async function reasons(grants: readonly unknown[]): Promise<unknown[]> {
    const dock = await createPermDock(versioned, member, {
      policies: memoryPolicySource(document(grants)),
    });
    const errors: unknown[] = [];
    dock.on('error', (error) => {
      errors.push(error);
    });
    // SAFETY: every 'error' event for a rejected hosted grant carries a reason string.
    return errors.map((error) => (error as { readonly reason: string }).reason);
  }

  it('drops a hosted approval that omits the staleOn a code allow requires', async () => {
    expect(
      await reasons([
        {
          id: 'g_weak',
          permission: 'filing.pay',
          to: { kind: 'role', role: 'auditor', scope: 'global' },
          approval: 'human',
        },
        {
          id: 'g_same',
          permission: 'filing.pay',
          to: { kind: 'role', role: 'auditor', scope: 'global' },
          approval: { staleOn: 'resource-change' },
        },
      ]),
    ).toEqual(['weaker-approval']);
  });

  it('drops staleOn on a resource without version or with an unknown value', async () => {
    expect(
      await reasons([
        {
          id: 'g_unversioned',
          permission: 'note.pin',
          to: { kind: 'role', role: 'auditor', scope: 'global' },
          approval: { staleOn: 'resource-change' },
        },
        {
          id: 'g_unknown',
          permission: 'filing.close',
          to: { kind: 'role', role: 'auditor', scope: 'global' },
          approval: { staleOn: 'always' },
        },
      ]),
    ).toEqual(['invalid', 'invalid']);
  });
});

describe('hosted grant validation', () => {
  const toMember = { kind: 'role', role: 'member', scope: 'global' } as const;
  const reasons = (grants: readonly unknown[]) =>
    mergeHostedGrants(policy, document(grants)).dropped.map((item) => [
      item.grant,
      item.reason,
    ]);

  it('rejects envelopes that are not objects or miss a field', () => {
    expect(() => parsePolicyDocument('[1]')).toThrow(/must be an object/u);
    expect(() => parsePolicyDocument(null)).toThrow(/must be an object/u);
    expect(() =>
      parsePolicyDocument({ v: 1, id: 'd', fingerprint: 'f', catalog: 'c' }),
    ).toThrow(/malformed policy document/u);
    expect(() =>
      parsePolicyDocument(
        JSON.stringify({
          v: 1,
          id: 'd',
          fingerprint: 'f',
          catalog: 'c',
          issuedAt: 1,
          grants: [],
        }),
      ),
    ).not.toThrow();
    expect(mergeHostedGrants(policy, null)).toEqual({ policy, dropped: [] });
  });

  it('drops malformed grants as invalid and names an id-less one by an empty string', () => {
    expect(
      reasons([
        'not a grant',
        { permission: 'invoice.read', to: toMember },
        {
          id: 'effect',
          permission: 'invoice.read',
          effect: 'maybe',
          to: toMember,
        },
        { id: 'no-to', permission: 'invoice.read' },
        { id: 'empty-to', permission: 'invoice.read', to: [] },
      ]),
    ).toEqual([
      ['', 'invalid'],
      ['', 'invalid'],
      ['effect', 'invalid'],
      ['no-to', 'invalid'],
      ['empty-to', 'unknown-grantee'],
    ]);
  });

  it('drops a grant or an approver of a grantee kind it does not know', () => {
    const forged = { kind: 'wizard', matched: true };
    expect(
      reasons([
        { id: 'forged-to', permission: 'invoice.read', to: forged },
        {
          id: 'forged-list',
          permission: 'invoice.read',
          to: [toMember, forged],
        },
        {
          id: 'forged-by',
          permission: 'invoice.export',
          to: toMember,
          approval: { by: forged },
        },
      ]),
    ).toEqual([
      ['forged-to', 'unknown-grantee'],
      ['forged-list', 'unknown-grantee'],
      ['forged-by', 'invalid'],
    ]);
  });

  it('drops approvals and fields that are not well formed', () => {
    const grant = (id: string, extra: Record<string, unknown>) => ({
      id,
      permission: 'invoice.export',
      to: toMember,
      ...extra,
    });
    expect(
      reasons([
        grant('approval-number', { approval: 5 }),
        grant('distinct-string', { approval: { distinct: 'no' } }),
        grant('empty-by', { approval: { by: [] } }),
        grant('ghost-by', {
          approval: { by: { kind: 'role', role: 'ghost', scope: 'global' } },
        }),
        grant('string-by', { approval: { by: ['member'] } }),
        grant('fields-string', { fields: 'ownerId' }),
        grant('fields-number', { fields: ['ownerId', 1] }),
        grant('authenticated-by', {
          approval: { by: { kind: 'authenticated' } },
        }),
        grant('member-by', { approval: { by: toMember, distinct: true } }),
        grant('no-by', { approval: { distinct: true } }),
        grant('fields', { fields: ['ownerId'] }),
        grant('check', { check: { op: 'eq', field: 'locked', value: false } }),
      ]),
    ).toEqual([
      ['approval-number', 'invalid'],
      ['distinct-string', 'invalid'],
      ['empty-by', 'invalid'],
      ['ghost-by', 'invalid'],
      ['string-by', 'invalid'],
      ['fields-string', 'invalid'],
      ['fields-number', 'invalid'],
    ]);
  });

  it('drops grantees the policy does not declare', () => {
    const grant = (id: string, to: unknown) => ({
      id,
      permission: 'invoice.export',
      to,
    });
    expect(
      reasons([
        grant('plan', { kind: 'plan', plan: 'enterprise' }),
        grant('other-resource', {
          kind: 'relation',
          resource: 'auditLog',
          relation: 'owner',
        }),
        grant('unknown-relation', {
          kind: 'relation',
          resource: 'invoice',
          relation: 'payer',
        }),
        grant('walk-unparented', {
          kind: 'relation',
          resource: 'invoice',
          relation: 'owner',
          through: 'parent',
        }),
        grant('depth-without-walk', {
          kind: 'relation',
          resource: 'invoice',
          relation: 'owner',
          depth: 2,
        }),
        grant('actor', { kind: 'actor', actor: 'agent' }),
        grant('assurance', { kind: 'assurance', acr: ['aal2'] }),
        grant('authenticated', { kind: 'authenticated' }),
        grant('mixed', [toMember, { kind: 'plan', plan: 'pro' }]),
      ]),
    ).toEqual([
      ['plan', 'unknown-grantee'],
      ['other-resource', 'unknown-grantee'],
      ['unknown-relation', 'unknown-grantee'],
      ['walk-unparented', 'unknown-grantee'],
      ['depth-without-walk', 'unknown-grantee'],
      ['actor', 'unknown-grantee'],
      ['assurance', 'unknown-grantee'],
      ['authenticated', 'unknown-grantee'],
    ]);
  });

  it('merges a hosted deny for a grantee list, and it wins over the hosted allow', async () => {
    const { dock } = await withDocument(proUser, [
      {
        id: 'g_pro_read',
        permission: 'auditLog.read',
        to: { kind: 'plan', plan: 'pro' },
      },
      {
        id: 'g_deny',
        permission: 'auditLog.read',
        effect: 'deny',
        to: [{ kind: 'plan', plan: 'pro' }],
      },
    ]);
    expect(dock.decide(permissions.auditLog.read, { id: 'a1' })).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'deny' }],
    });
  });

  it('drops a hosted allow whose approver differs from the code approver', () => {
    const strict = definePolicy(
      { permissions, plans },
      {
        roles: [
          role('member', [
            allow(permissions.invoice.delete, {
              approval: { by: 'auditor' },
            }),
          ]),
          role('auditor', []),
        ],
        principal: (user: User) => user,
        hostable: [permissions.invoice],
      },
    );
    const drop = (approval: unknown) =>
      mergeHostedGrants(
        strict,
        document([
          { id: 'g', permission: 'invoice.delete', to: toMember, approval },
        ]),
      ).dropped.map((item) => item.reason);
    expect(
      drop({ by: { kind: 'role', role: 'member', scope: 'global' } }),
    ).toEqual(['weaker-approval']);
    expect(
      drop({ by: { kind: 'role', role: 'auditor', scope: 'global' } }),
    ).toEqual([]);
  });
});

describe('isPortableCondition', () => {
  it.each([
    [{ op: 'eq', field: 'a', value: 1 }, true],
    [{ op: 'eq', field: 'a', value: null }, true],
    [{ op: 'eq', field: 'a', value: { ref: 'principal.id' } }, true],
    [{ op: 'eq', field: 'a', value: { date: '2026-01-01' } }, true],
    [{ op: 'eq', field: 'a', value: [1, 'b', true] }, true],
    [{ op: 'eq', field: '', value: 1 }, false],
    [{ op: 'eq', field: 5, value: 1 }, false],
    [{ op: 'eq', field: 'a', value: Number.POSITIVE_INFINITY }, false],
    [{ op: 'eq', field: 'a', value: { ref: 'constructor.x' } }, false],
    [{ op: 'eq', field: 'a', value: { date: 5 } }, false],
    [{ op: 'eq', field: 'a', value: { ref: 'a', date: 'b' } }, false],
    [{ op: 'eq', field: 'a', value: { other: 'x' } }, false],
    [{ op: 'eq', field: 'a', value: () => 1 }, false],
    [{ op: 'in', field: 'a', value: [1, 2] }, true],
    [{ op: 'notIn', field: 'a', value: { ref: 'principal.roles' } }, true],
    [{ op: 'in', field: 'a', value: 1 }, false],
    [{ op: 'isNull', field: 'a', value: true }, true],
    [{ op: 'isNull', field: 'a', value: 'yes' }, false],
    [{ op: 'and', conditions: [{ op: 'eq', field: 'a', value: 1 }] }, true],
    [{ op: 'or', conditions: 'x' }, false],
    [{ op: 'not', condition: { op: 'eq', field: 'a', value: 1 } }, true],
    [
      { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['admin'] },
      true,
    ],
    [
      {
        op: 'memberOf',
        scope: 'resource',
        field: 'folderId',
        roles: [],
        resource: 'folder',
        parents: ['parentId', { field: 'spaceId', resource: 'space' }],
      },
      true,
    ],
    [{ op: 'memberOf', scope: 'team', field: 'teamId', roles: [] }, true],
    [{ op: 'memberOf', scope: 'org', field: 'orgId', roles: [] }, false],
    [
      { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: 'admin' },
      false,
    ],
    [{ op: 'memberOf', scope: 'tenant', field: 'orgId', roles: [1] }, false],
    [
      {
        op: 'memberOf',
        scope: 'tenant',
        field: 'orgId',
        roles: [],
        resource: 1,
      },
      false,
    ],
    [
      {
        op: 'memberOf',
        scope: 'tenant',
        field: 'orgId',
        roles: [],
        parents: 'p',
      },
      false,
    ],
    [
      {
        op: 'memberOf',
        scope: 'tenant',
        field: 'orgId',
        roles: [],
        parents: [{ field: 'p', resource: 1 }],
      },
      false,
    ],
    [{ op: 'opaque', sql: 'true', fingerprint: 'f' }, false],
    [{ op: 'sqlFunction', name: 'f', args: [] }, false],
    [{ op: 5 }, false],
    [[{ op: 'eq', field: 'a', value: 1 }], false],
    ['eq', false],
  ])('classifies %j as portable: %s', (condition, expected) => {
    expect(isPortableCondition(condition)).toBe(expected);
  });
});
