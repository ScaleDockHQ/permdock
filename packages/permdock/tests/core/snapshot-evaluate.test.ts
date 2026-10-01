import { describe, expect, it } from 'vitest';

import type { Condition } from '../../src/conditions/ast.ts';
import type { Snapshot, SnapshotGrant } from '../../src/core/interfaces.ts';

import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { rowId } from '../../src/core/snapshot-evaluate.ts';
import { parseSnapshot } from '../../src/core/snapshot.ts';
import { reasonOf } from '../fixtures/decisions.ts';

const permissions = definePermissions({
  doc: resource({ actions: ['read', 'update'], collection: ['create'] }),
});

const member = { kind: 'role', role: 'member', scope: 'global' } as const;
const orgMembership = { scope: 'org', id: 'o1', roles: ['member'] } as const;

function snapshotWith(
  grants: readonly SnapshotGrant[],
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    v: 1,
    issuedAt: 1,
    subject: {
      principal: {
        id: 'u1',
        roles: ['member'],
        tenant: 'o1',
        memberships: [orgMembership],
      },
      context: {},
    },
    roles: ['member'],
    grants,
    tenants: ['o1'],
    scopes: [
      { name: 'org', key: 'orgId', resources: ['doc'] },
      { name: 'team', key: 'teamId', within: 'org' },
    ],
    ...extra,
  };
}

const allowRead: SnapshotGrant = {
  permission: 'doc.read',
  effect: 'allow',
  role: 'member',
  to: member,
};

const opaque: Condition = { op: 'opaque', sql: 'true', fingerprint: 'f' };

describe('rowId', () => {
  it.each([
    [null, '*'],
    ['p1', '*'],
    [{}, '*'],
    [{ id: true }, '*'],
    [{ id: 'p1' }, 'p1'],
    [{ id: 7 }, '7'],
  ])('reads the id of %j as %s', (data, expected) => {
    expect(rowId(data)).toBe(expected);
  });
});

describe('evaluateSnapshot', () => {
  it('denies a grantee that does not match with its reason', () => {
    const client = fromSnapshot(
      snapshotWith([{ ...allowRead, to: { kind: 'plan', plan: 'pro' } }]),
    );
    expect(reasonOf(client.decide(permissions.doc.read, { id: 'd1' }))).toBe(
      'not-entitled',
    );
  });

  it('denies a scoped grant to an anonymous subject', () => {
    const snapshot = snapshotWith(
      [
        {
          ...allowRead,
          to: { kind: 'anyone' },
          scope: 'org',
          membership: orgMembership,
        },
      ],
      { subject: { principal: null, context: {} } },
    );
    const decision = fromSnapshot(snapshot).decide(permissions.doc.read, {
      id: 'd1',
      orgId: 'o1',
    });
    expect(reasonOf(decision)).toBe('no-membership');
  });

  it('denies a scoped grant outside the selected team', () => {
    const snapshot = snapshotWith([
      { ...allowRead, scope: 'org', membership: orgMembership },
    ]);
    const row = { id: 'd1', orgId: 'o1' };
    expect(fromSnapshot(snapshot).can(permissions.doc.read, row)).toBe(true);
    const scoped = fromSnapshot(snapshot, { team: 'blue' });
    expect(reasonOf(scoped.decide(permissions.doc.read, row))).toBe('scope');
  });

  it('fails a partitioned scope closed for an instance check with no row', () => {
    const snapshot = snapshotWith([
      { ...allowRead, scope: 'org', membership: orgMembership },
    ]);
    // SAFETY: an instance check without a row, as an untyped caller could make it.
    const read = permissions.doc.read as never;
    expect(reasonOf(fromSnapshot(snapshot).decide(read))).toBe(
      'tenant-mismatch',
    );
  });

  it('denies an opaque where or check as opaque-condition', () => {
    const where = fromSnapshot(snapshotWith([{ ...allowRead, where: opaque }]));
    expect(reasonOf(where.decide(permissions.doc.read, { id: 'd1' }))).toBe(
      'opaque-condition',
    );
    const check = fromSnapshot(
      snapshotWith([
        {
          ...allowRead,
          where: { op: 'eq', field: 'id', value: 'd1' },
          check: opaque,
        },
      ]),
    );
    expect(reasonOf(check.decide(permissions.doc.read, { id: 'd1' }))).toBe(
      'opaque-condition',
    );
  });

  it('evaluates a check against the next row', () => {
    const grant: SnapshotGrant = {
      ...allowRead,
      permission: 'doc.update',
      check: { op: 'eq', field: 'status', value: 'draft' },
    };
    const client = fromSnapshot(snapshotWith([grant]));
    const draft = { id: 'd1', status: 'draft' };
    const sent = { id: 'd1', status: 'sent' };
    expect(
      client.decide(permissions.doc.update, { current: sent, next: draft })
        .outcome,
    ).toBe('granted');
    expect(
      reasonOf(
        client.decide(permissions.doc.update, { current: draft, next: sent }),
      ),
    ).toBe('condition');
    // SAFETY: an instance check without a row, as an untyped caller could make it.
    const update = permissions.doc.update as never;
    expect(reasonOf(client.decide(update))).toBe('condition');
  });

  it('denies a check that reaches an opaque node while evaluating', () => {
    const grant: SnapshotGrant = {
      ...allowRead,
      check: { op: 'or', conditions: [opaque] },
    };
    const client = fromSnapshot(snapshotWith([grant]));
    expect(reasonOf(client.decide(permissions.doc.read, { id: 'd1' }))).toBe(
      'opaque-condition',
    );
  });

  it('skips a non-portable deny that does not cover the requested field', () => {
    const client = fromSnapshot(
      snapshotWith([
        allowRead,
        {
          ...allowRead,
          effect: 'deny',
          portable: false,
          fields: ['secret'],
        },
      ]),
    );
    const row = { id: 'd1', title: 't', secret: 's' };
    expect(client.can(permissions.doc.read, row, { field: 'title' })).toBe(
      true,
    );
    expect(
      reasonOf(client.decide(permissions.doc.read, row, { field: 'secret' })),
    ).toBe('opaque-condition');
    expect(client.decide(permissions.doc.read, row).outcome).toBe('granted');
  });

  it('binds the token to the current row when the next row is absent', () => {
    const client = fromSnapshot(snapshotWith([allowRead]));
    const first = client.decide(permissions.doc.read, {
      current: { title: 'a' },
      next: undefined,
    });
    const second = client.decide(permissions.doc.read, {
      current: { title: 'b' },
      next: undefined,
    });
    if (first.outcome !== 'granted' || second.outcome !== 'granted') {
      throw new Error('expected grants');
    }
    expect(first.token).not.toBe(second.token);
  });

  it('compiles where for a partitioned scoped grant from the snapshot scopes', () => {
    const client = fromSnapshot(
      snapshotWith([{ ...allowRead, scope: 'org', membership: orgMembership }]),
    );
    const where = client.where(permissions.doc.read);
    expect(where.partial).toBe(false);
    expect(JSON.stringify(where)).toContain('orgId');
  });
});

describe('a forged snapshot grantee', () => {
  it('never grants through a grantee kind the client does not know', () => {
    const forged = parseSnapshot(
      JSON.stringify(
        snapshotWith([
          // SAFETY: a forged grantee kind, as a tampered snapshot could carry.
          {
            ...allowRead,
            role: null,
            to: { kind: 'wizard', matched: true } as never,
          },
        ]),
      ),
    );
    const client = fromSnapshot(forged);
    expect({
      can: client.can(permissions.doc.read, { id: 'd1' }),
      reason: reasonOf(client.decide(permissions.doc.read, { id: 'd1' })),
    }).toEqual({ can: false, reason: 'no-grant' });
  });

  it('applies a deny whose grantee kind the client does not know', () => {
    const client = fromSnapshot(
      parseSnapshot(
        JSON.stringify(
          snapshotWith([
            allowRead,
            // SAFETY: a deny naming a grantee kind newer than this client.
            {
              permission: 'doc.read',
              effect: 'deny',
              role: null,
              to: { kind: 'wizard' } as never,
            },
          ]),
        ),
      ),
    );
    expect(client.can(permissions.doc.read, { id: 'd1' })).toBe(false);
  });
});
