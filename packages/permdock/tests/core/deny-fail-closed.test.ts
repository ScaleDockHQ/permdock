import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from '../../src/index.ts';

const Invoice = z.object({ id: z.string(), amount: z.number() });
const permissions = definePermissions({
  invoice: resource(Invoice, { id: 'id', actions: ['update'] }),
});
type Row = z.infer<typeof Invoice>;
const invoice: Row = { id: 'i1', amount: 50 };
const user = { id: 'u1', roles: ['member'] };
const subject = (
  input: { readonly id: string; readonly roles: readonly string[] } | null,
) => (input === null ? null : { id: input.id, roles: input.roles });
const opaqueWhere = { sql: 'amount > 1000', fingerprint: 'big' };

function policyWith(denyGrant: ReturnType<typeof deny>) {
  return definePolicy(permissions, {
    roles: [role('member', [allow(permissions.invoice.update), denyGrant])],
    subject,
  });
}

describe('a deny that cannot be evaluated denies', () => {
  it('denies when a deny closure throws', async () => {
    const policy = policyWith(
      deny(permissions.invoice.update, (): boolean => {
        throw new Error('lookup failed');
      }),
    );
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.invoice.update, invoice);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('closure-error');
  });

  it('denies when a deny has an opaque where', async () => {
    const policy = policyWith(
      deny(permissions.invoice.update, { where: opaqueWhere }),
    );
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.invoice.update, invoice);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('opaque-condition');
  });

  it('denies when a deny nests an opaque condition', async () => {
    const policy = policyWith(
      deny(permissions.invoice.update, {
        where: { or: [opaqueWhere, { amount: { gt: 1000 } }] },
      }),
    );
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.invoice.update, invoice);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('opaque-condition');
  });

  it('denies the same way from a snapshot', async () => {
    const policy = policyWith(
      deny(permissions.invoice.update, {
        where: { or: [opaqueWhere, { amount: { gt: 1000 } }] },
      }),
    );
    const server = await createPermDock(policy, user);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    const decision = client.decide(permissions.invoice.update, invoice);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('opaque-condition');
  });

  it('does not grant an allow that negates an opaque condition', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.invoice.update, { where: { not: opaqueWhere } }),
        ]),
      ],
      subject,
    });
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.invoice.update, invoice);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('opaque-condition');
  });

  it('still fails only the grant when an allow cannot be evaluated', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.invoice.update, { where: opaqueWhere }),
          allow(permissions.invoice.update, { where: { amount: { lt: 100 } } }),
        ]),
      ],
      subject,
    });
    const permdock = await createPermDock(policy, user);
    expect(permdock.can(permissions.invoice.update, invoice)).toBe(true);
  });
});
