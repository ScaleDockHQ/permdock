import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from '../../src/index.ts';

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({
  doc: resource(Doc, { id: 'id', actions: ['read', 'update'] }),
});
const open = { id: 'd1', locked: false };
const locked = { id: 'd2', locked: true };
const subject = (user: { id: string; roles: string[] }) => user;

describe('invariant 2: deny overrides allow', () => {
  it('denies whatever the grant order inside one role', async () => {
    for (const grants of [
      [
        allow(permissions.doc.update),
        deny(permissions.doc.update, { where: { locked: true } }),
      ],
      [
        deny(permissions.doc.update, { where: { locked: true } }),
        allow(permissions.doc.update),
      ],
    ]) {
      const policy = definePolicy(permissions, {
        roles: [role('editor', grants)],
        subject,
      });
      const permdock = await createPermDock(policy, {
        id: 'u1',
        roles: ['editor'],
      });
      expect(permdock.can(permissions.doc.update, locked)).toBe(false);
      expect(permdock.can(permissions.doc.update, open)).toBe(true);
    }
  });

  it('lets a deny in one role override an allow in another', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('owner', [allow(permissions.doc.update)]),
        role('suspended', [deny(permissions.doc.update)]),
      ],
      subject,
    });
    for (const roles of [
      ['owner', 'suspended'],
      ['suspended', 'owner'],
    ]) {
      const permdock = await createPermDock(policy, { id: 'u1', roles });
      const decision = permdock.decide(permissions.doc.update, open);
      expect(decision.outcome).toBe('denied');
      expect(decision.denials[0]?.reason).toBe('deny');
    }
  });

  it('lets a deny override an allow that needs approval', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('editor', [
          allow(permissions.doc.update, { approval: 'human' }),
          deny(permissions.doc.update, { where: { locked: true } }),
        ]),
      ],
      subject,
    });
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['editor'],
    });
    expect(permdock.decide(permissions.doc.update, locked).outcome).toBe(
      'denied',
    );
    expect(permdock.decide(permissions.doc.update, open).outcome).toBe(
      'approval-required',
    );
  });

  it('keeps the deny in the server-side where filter', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('editor', [
          allow(permissions.doc.read),
          deny(permissions.doc.read, { where: { locked: true } }),
        ]),
      ],
      subject,
    });
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['editor'],
    });
    const where = permdock.where(permissions.doc.read);
    expect(where.condition).toEqual({
      op: 'not',
      condition: { op: 'eq', field: 'locked', value: true },
    });
  });
});
