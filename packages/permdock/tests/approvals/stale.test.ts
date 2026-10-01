import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Decision } from '../../src/core/decision.ts';

import {
  memoryApprovalStore,
  resolveApproval,
  resumeDecision,
} from '../../src/approvals/index.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';

const Invoice = z.object({
  id: z.string(),
  amount: z.number(),
  updatedAt: z.string(),
});

const permissions = definePermissions({
  invoice: resource(Invoice, {
    actions: ['pay', 'void'],
    version: 'updatedAt',
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role('clerk', [
      allow(permissions.invoice.pay, {
        approval: { staleOn: 'resource-change' },
      }),
      allow(permissions.invoice.void, { approval: 'human' }),
    ]),
    role('manager', []),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

const clerk = { id: 'u_1', roles: ['clerk'] };
const manager = { id: 'u_9', roles: ['manager'] };

const v1 = { id: 'inv_1', amount: 100, updatedAt: '2026-09-29T10:00:00Z' };
const v2 = { ...v1, amount: 900, updatedAt: '2026-09-29T10:05:00Z' };

async function run(
  row: typeof v1,
  token: string | undefined,
  store: ReturnType<typeof memoryApprovalStore>,
  permission:
    | typeof permissions.invoice.pay
    | typeof permissions.invoice.void = permissions.invoice.pay,
): Promise<{ readonly decision: Decision; readonly resumed: Decision }> {
  const permdock = await createPermDock(policy, clerk);
  const decision = permdock.decide(permission, row);
  const resumed = await resumeDecision({
    decision,
    permission,
    subject: permdock.subject,
    store,
    resource: { type: 'invoice', id: row.id },
    adapter: 'test',
    token,
  });
  return { decision, resumed };
}

async function approve(
  store: ReturnType<typeof memoryApprovalStore>,
  token: string,
): Promise<void> {
  const by = await createPermDock(policy, manager);
  await resolveApproval(store, token, { status: 'approved', by: by.subject });
}

describe('approvals that go stale on a resource change', () => {
  it('binds the token to the version field', async () => {
    const permdock = await createPermDock(policy, clerk);
    const first = permdock.decide(permissions.invoice.pay, v1);
    const same = permdock.decide(permissions.invoice.pay, { ...v1 });
    const changed = permdock.decide(permissions.invoice.pay, v2);
    expect(first.outcome).toBe('approval-required');
    const tokenOf = (decision: Decision): string | undefined =>
      decision.outcome === 'denied' ? undefined : decision.token;
    expect(tokenOf(same)).toBe(tokenOf(first));
    expect(tokenOf(changed)).not.toBe(tokenOf(first));
  });

  it('leaves the token of an approval without staleOn unchanged by the row', async () => {
    const permdock = await createPermDock(policy, clerk);
    const before = permdock.decide(permissions.invoice.void, v1);
    const after = permdock.decide(permissions.invoice.void, v2);
    expect(before.outcome === 'approval-required' && before.token).toBe(
      after.outcome === 'approval-required' && after.token,
    );
  });

  it('resumes once when the row is unchanged', async () => {
    const store = memoryApprovalStore();
    const { decision } = await run(v1, undefined, store);
    const token =
      decision.outcome === 'approval-required' ? decision.token : '';
    await approve(store, token);
    const { resumed } = await run(v1, token, store);
    expect(resumed.outcome).toBe('granted');
  });

  it('denies with stale-approval after the row changed, then asks again', async () => {
    const store = memoryApprovalStore();
    const { decision } = await run(v1, undefined, store);
    const old = decision.outcome === 'approval-required' ? decision.token : '';
    await approve(store, old);

    const stale = await run(v2, old, store);
    expect(stale.resumed).toEqual({
      outcome: 'denied',
      denials: [{ role: null, reason: 'stale-approval' }],
      alternatives: [],
    });
    expect((await store.get(old))?.consumedAt).toBeUndefined();

    const again = await run(v2, undefined, store);
    expect(again.resumed.outcome).toBe('approval-required');
    const fresh =
      again.resumed.outcome === 'approval-required' ? again.resumed.token : '';
    expect(fresh).not.toBe(old);
    expect((await store.get(fresh))?.status).toBe('pending');
    expect((await store.get(fresh))?.approvers?.staleOn).toBe(
      'resource-change',
    );

    await approve(store, fresh);
    expect((await run(v2, fresh, store)).resumed.outcome).toBe('granted');
  });

  it('treats a pending request for an earlier version as stale too', async () => {
    const store = memoryApprovalStore();
    const { decision } = await run(v1, undefined, store);
    const old = decision.outcome === 'approval-required' ? decision.token : '';
    expect((await run(v2, old, store)).resumed.outcome).toBe('denied');
  });

  it('keeps an approval without staleOn valid across a row change', async () => {
    const store = memoryApprovalStore();
    const permission = permissions.invoice.void;
    const { decision } = await run(v1, undefined, store, permission);
    const token =
      decision.outcome === 'approval-required' ? decision.token : '';
    await approve(store, token);
    expect((await run(v2, token, store, permission)).resumed.outcome).toBe(
      'granted',
    );
  });

  it('asks again, without stale-approval, for a token from another row', async () => {
    const store = memoryApprovalStore();
    const { decision } = await run(v1, undefined, store);
    const token =
      decision.outcome === 'approval-required' ? decision.token : '';
    await approve(store, token);
    const other = { ...v1, id: 'inv_2' };
    expect((await run(other, token, store)).resumed.outcome).toBe(
      'approval-required',
    );
  });
});

describe('staleOn definition checks', () => {
  it('requires the resource to declare version', () => {
    const plain = definePermissions({
      invoice: resource(Invoice, { actions: ['pay'] }),
    });
    expect(() =>
      definePolicy(plain, {
        roles: [
          role('clerk', [
            allow(plain.invoice.pay, {
              approval: { staleOn: 'resource-change' },
            }),
          ]),
        ],
        subject: (user: { readonly id: string }) => user,
      }),
    ).toThrow(/version/u);
  });

  it('rejects staleOn on a collection action', () => {
    const tree = definePermissions({
      invoice: resource(Invoice, {
        actions: ['pay'],
        collection: ['create'],
        version: 'updatedAt',
      }),
    });
    expect(() =>
      definePolicy(tree, {
        roles: [
          role('clerk', [
            allow(tree.invoice.create, {
              approval: { staleOn: 'resource-change' },
            }),
          ]),
        ],
        subject: (user: { readonly id: string }) => user,
      }),
    ).toThrow(/collection/u);
  });

  it('rejects an unknown staleOn value and an unsafe version field', () => {
    // SAFETY: a deliberately invalid staleOn value to exercise allow()'s validation.
    expect(() =>
      allow(permissions.invoice.pay, {
        approval: { staleOn: 'always' as never },
      }),
    ).toThrow(/staleOn/u);
    expect(() =>
      definePermissions({
        invoice: resource(Invoice, { actions: ['pay'], version: '__proto__' }),
      }),
    ).toThrow(/version field/u);
  });

  it('keeps staleOn on the normalised approval with the default approvers', () => {
    const [grant] = [
      allow(permissions.invoice.pay, {
        approval: { staleOn: 'resource-change' },
      }),
    ].flat();
    expect(grant?.approval).toEqual({
      by: { kind: 'authenticated' },
      staleOn: 'resource-change',
    });
  });
});
