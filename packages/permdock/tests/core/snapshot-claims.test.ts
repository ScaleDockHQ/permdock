import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { principal } from '../../src/conditions/refs.ts';
import { authenticated } from '../../src/core/grantee.ts';
import {
  fromSnapshot,
  createPermDock,
  parseSnapshot,
} from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy } from '../../src/core/policy.ts';
import { refAt } from '../fixtures/refs.ts';

const Entry = z.object({
  id: z.string(),
  region: z.string(),
  ownerId: z.string(),
});

const permissions = definePermissions({
  record: resource(Entry, { actions: ['read', 'delete'] }),
});

const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.record.read, {
      to: authenticated(),
      where: {
        region: refAt(principal, 'claims', 'attrs', 'region'),
        ownerId: principal.id,
      },
    }),
    allow(permissions.record.delete, {
      to: authenticated(),
      where: {
        region: { notIn: refAt(principal, 'claims', 'attrs', 'blocked') },
      },
    }),
  ],
  principal: (user: {
    readonly id: string;
    readonly claims?: Readonly<Record<string, unknown>>;
  }) => user,
});

const user = {
  id: 'u_1',
  claims: { attrs: { region: 'eu', blocked: ['us'] } },
};

describe('claims in snapshots', () => {
  it('binds claim refs to the subject values and keeps carried refs', async () => {
    const permdock = await createPermDock(policy, user);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise || typeof snapshot !== 'object') {
      throw new Error('expected a json snapshot');
    }
    expect(snapshot.subject.principal).not.toHaveProperty('claims');
    const where = (key: string): unknown =>
      snapshot.grants.find((grant) => grant.permission === key)?.where;
    expect(where('record.read')).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', field: 'region', value: 'eu' },
        { op: 'eq', field: 'ownerId', value: { ref: 'principal.id' } },
      ],
    });
    expect(where('record.delete')).toEqual({
      op: 'notIn',
      field: 'region',
      value: ['us'],
    });
  });

  it('never lets the snapshot client grant what the server denies', async () => {
    const permdock = await createPermDock(policy, user);
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    const rows = [
      { id: 'a', region: 'eu', ownerId: 'u_1' },
      { id: 'b', region: 'us', ownerId: 'u_1' },
      { id: 'c', region: 'eu', ownerId: 'u_2' },
    ];
    for (const row of rows) {
      for (const permission of [
        permissions.record.read,
        permissions.record.delete,
      ]) {
        expect(client.can(permission, row), `${permission.key} ${row.id}`).toBe(
          permdock.can(permission, row),
        );
      }
    }
  });
});
