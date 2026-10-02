import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { branchClauses, compileGrants } from '../../src/cli/rls-compile.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  fromSnapshot,
  resource,
  role,
} from '../../src/index.ts';

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({
  doc: resource(Doc, { id: 'id', actions: ['read', 'update', 'delete'] }),
});
const doc = { id: 'd1', locked: false };
const subject = (user: { id: string; roles: string[] }) => user;

const FROM = Date.parse('2026-03-01T00:00:00Z') / 1000;
const UNTIL = Date.parse('2026-04-01T00:00:00Z') / 1000;
const before = FROM - 60;
const during = FROM + 60;
const after = UNTIL + 60;

const policy = definePolicy(permissions, {
  roles: [
    role('contractor', [
      allow(permissions.doc.read, {
        validFrom: '2026-03-01T00:00:00Z',
        validUntil: '2026-04-01T00:00:00Z',
      }),
      allow(permissions.doc.update, { validUntil: UNTIL }),
      allow(permissions.doc.delete),
      deny(permissions.doc.delete, { validUntil: UNTIL, name: 'freeze' }),
    ]),
  ],
  subject,
});

async function contractor() {
  return createPermDock(policy, { id: 'u1', roles: ['contractor'] });
}

describe('grant validity', () => {
  it('normalises RFC 3339 and Unix-second bounds to seconds', () => {
    const [read, update] = policy.grants.filter(
      (grant) => grant.effect === 'allow' && grant.role === 'contractor',
    );
    expect(read?.validity).toEqual({ from: FROM, until: UNTIL });
    expect(update?.validity).toEqual({ until: UNTIL });
    expect(Object.isFrozen(read?.validity)).toBe(true);
  });

  it('rejects a bound that does not parse', () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role('r', [allow(permissions.doc.read, { validFrom: 'tomorrow' })]),
        ],
        subject,
      }),
    ).toThrow(
      "validFrom on 'doc.read' must be an RFC 3339 string or Unix seconds",
    );
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role('r', [allow(permissions.doc.read, { validUntil: Number.NaN })]),
        ],
        subject,
      }),
    ).toThrow("validUntil on 'doc.read'");
  });

  it('rejects a window that ends before it starts', () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role('r', [
            allow(permissions.doc.read, { validFrom: UNTIL, validUntil: FROM }),
          ]),
        ],
        subject,
      }),
    ).toThrow('must be after validFrom');
  });

  it('grants inside the window, from inclusive and until exclusive', async () => {
    const permdock = await contractor();
    expect(permdock.can(permissions.doc.read, doc, { now: FROM })).toBe(true);
    expect(permdock.can(permissions.doc.read, doc, { now: during })).toBe(true);
    expect(permdock.can(permissions.doc.read, doc, { now: UNTIL })).toBe(false);
  });

  it('denies an inactive allow with inactive-grant and the window', async () => {
    const permdock = await contractor();
    for (const now of [before, after]) {
      const decision = permdock.decide(permissions.doc.read, doc, { now });
      expect(decision.outcome).toBe('denied');
      if (decision.outcome === 'denied') {
        expect(decision.denials).toEqual([
          {
            role: 'contractor',
            reason: 'inactive-grant',
            detail: { from: FROM, until: UNTIL },
          },
        ]);
      }
    }
  });

  it('does not apply an expired deny and records it as skipped', async () => {
    const permdock = await contractor();
    expect(permdock.can(permissions.doc.delete, doc, { now: during })).toBe(
      false,
    );
    const explained = permdock.explain(permissions.doc.delete, doc, {
      now: after,
    });
    expect(explained.outcome).toBe('granted');
    expect(explained.trace.skipped).toEqual([
      {
        role: 'contractor',
        permission: 'doc.delete',
        effect: 'deny',
        why: 'validity',
      },
    ]);
  });

  it('reads the whole simulate batch as of now', async () => {
    const permdock = await contractor();
    const checks = [
      [permissions.doc.read, doc],
      [permissions.doc.update, doc],
    ] as const;
    expect(
      permdock.simulate(checks, { now: during }).map((d) => d.outcome),
    ).toEqual(['granted', 'granted']);
    expect(
      permdock.simulate(checks, { now: after }).map((d) => d.outcome),
    ).toEqual(['denied', 'denied']);
  });

  it('carries validity into the snapshot and evaluates it there', async () => {
    const permdock = await contractor();
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('unsigned snapshot expected');
    }
    const read = snapshot.grants.find(
      (grant) => grant.permission === 'doc.read',
    );
    expect(read?.validity).toEqual({ from: FROM, until: UNTIL });
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.doc.read, doc, { now: during })).toBe(true);
    const decision = client.decide(permissions.doc.read, doc, { now: after });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('inactive-grant');
    }
    expect(
      client.simulate([[permissions.doc.read, doc]], { now: before })[0]
        ?.outcome,
    ).toBe('denied');
    expect(client.can(permissions.doc.delete, doc, { now: after })).toBe(true);
  });

  it('drops inactive grants from where()', async () => {
    const expired = definePolicy(permissions, {
      roles: [
        role('contractor', [
          allow(permissions.doc.read, { validUntil: '2000-01-01T00:00:00Z' }),
          allow(permissions.doc.update),
          deny(permissions.doc.update, {
            where: { locked: true },
            validUntil: '2000-01-01T00:00:00Z',
          }),
        ]),
      ],
      subject,
    });
    const permdock = await createPermDock(expired, {
      id: 'u1',
      roles: ['contractor'],
    });
    expect(permdock.where(permissions.doc.read).condition).toEqual({
      op: 'or',
      conditions: [],
    });
    expect(
      JSON.stringify(permdock.where(permissions.doc.update)),
    ).not.toContain('locked');
  });

  it('includes validity in the policy fingerprint', () => {
    const other = definePolicy(permissions, {
      roles: [
        role('contractor', [
          allow(permissions.doc.read, {
            validFrom: '2026-03-01T00:00:00Z',
            validUntil: '2026-05-01T00:00:00Z',
          }),
          allow(permissions.doc.update, { validUntil: UNTIL }),
          allow(permissions.doc.delete),
          deny(permissions.doc.delete, { validUntil: UNTIL, name: 'freeze' }),
        ]),
      ],
      subject,
    });
    expect(other.fingerprint).not.toBe(policy.fingerprint);
  });

  it('compiles the window into the RLS access check', () => {
    const { branches } = compileGrants(
      policy,
      {
        dialect: 'supabase',
        tenantClaim: 'tenant',
        scopes: scopeList(undefined),
        gucPrefix: 'permdock',
      },
      undefined,
      [],
      false,
    );
    const read = branches.find(
      (branch) =>
        branch.permissionKey === 'doc.read' && branch.command === 'select',
    );
    const update = branches.find(
      (branch) => branch.permissionKey === 'doc.update',
    );
    const freeze = branches.find(
      (branch) =>
        branch.permissionKey === 'doc.delete' && branch.effect === 'deny',
    );
    expect(read?.access).toContain(`now() >= to_timestamp(${FROM})`);
    expect(read?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(update?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(update?.access).not.toContain('now() >=');
    expect(freeze?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(branchClauses(read!).using).toContain('to_timestamp');
  });
});
