import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LimitStore } from '../../src/core/interfaces.ts';
import type { RoleBinding } from '../../src/core/policy.ts';

import { memoryLimitStore } from '../../src/core/limits.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';

const Report = z.object({
  id: z.string(),
  ownerId: z.string(),
});

const permissions = definePermissions({
  report: resource(Report, {
    id: 'id',
    actions: ['export', 'read'],
    collection: ['create'],
  }),
});

const report = { id: 'r1', ownerId: 'u1' };

const limited = role('member', [
  allow(permissions.report.export, { limit: { count: 2, per: 'hour' } }),
  allow(permissions.report.read),
]);

const approved = role('reviewer', [
  allow(permissions.report.export, {
    limit: { count: 1, per: 'hour' },
    approval: 'human',
  }),
]);

const fallback = role('staff', [
  allow(permissions.report.export, { limit: { count: 1, per: 'hour' } }),
  allow(permissions.report.export),
]);

function policyFor(
  roles: readonly RoleBinding[],
): ReturnType<typeof definePolicy> {
  return definePolicy(permissions, {
    roles,
    subject: (user: {
      readonly id: string;
      readonly roles: readonly string[];
    }) => user,
  });
}

async function dock(
  roles: readonly RoleBinding[],
  roleName: string,
  options?: Parameters<typeof createPermDock>[2],
) {
  return createPermDock(
    policyFor(roles),
    { id: 'u1', roles: [roleName] },
    options,
  );
}

describe('quota grants', () => {
  it('denies a quota grant when no LimitStore is configured', async () => {
    const permdock = await dock([limited], 'member');
    const decision = permdock.decide(permissions.report.export, report);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('limit-unavailable');
    }
    expect(permdock.can(permissions.report.export, report)).toBe(false);
    expect(permdock.can(permissions.report.read, report)).toBe(true);
  });

  it('lets can peek without consuming', async () => {
    const limits = memoryLimitStore();
    const permdock = await dock([limited], 'member', { limits });
    expect(permdock.can(permissions.report.export, report)).toBe(true);
    expect(permdock.can(permissions.report.export, report)).toBe(true);
    expect(permdock.can(permissions.report.export, report)).toBe(true);
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    const exhausted = permdock.decide(permissions.report.export, report);
    expect(exhausted.outcome).toBe('denied');
    if (exhausted.outcome === 'denied') {
      expect(exhausted.denials[0]?.reason).toBe('limit');
    }
    expect(permdock.can(permissions.report.export, report)).toBe(false);
  });

  it('keeps can and decide synchronous', async () => {
    const permdock = await dock([limited], 'member', {
      limits: memoryLimitStore(),
    });
    expect(permdock.can(permissions.report.export, report)).not.toBeInstanceOf(
      Promise,
    );
    expect(
      permdock.decide(permissions.report.export, report),
    ).not.toBeInstanceOf(Promise);
  });

  it('fails closed when consume returns a thenable', async () => {
    const limits: LimitStore = {
      consume: () => Promise.resolve({ remaining: 99 }),
      remaining: () => ({ remaining: 99 }),
    };
    const permdock = await dock([limited], 'member', { limits });
    expect(permdock.can(permissions.report.export, report)).toBe(true);
    const decision = permdock.decide(permissions.report.export, report);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('limit-unavailable');
    }
  });

  it('fails closed when the store throws', async () => {
    const limits: LimitStore = {
      consume(): never {
        throw new Error('redis down');
      },
      remaining(): never {
        throw new Error('redis down');
      },
    };
    const permdock = await dock([limited], 'member', { limits });
    expect(permdock.can(permissions.report.export, report)).toBe(false);
    const decision = permdock.decide(permissions.report.export, report);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('limit-unavailable');
    }
  });

  it('fails closed when remaining is a thenable', async () => {
    const limits: LimitStore = {
      consume: () => ({ remaining: 1 }),
      // SAFETY: a deliberately thenable answer, to exercise the fail-closed deny.
      remaining: () => Promise.resolve({ remaining: 1 }) as never,
    };
    const permdock = await dock([limited], 'member', { limits });
    expect(permdock.can(permissions.report.export, report)).toBe(false);
  });

  it('does not consume on filter or simulate', async () => {
    const limits = memoryLimitStore();
    const once = role('member', [
      allow(permissions.report.export, { limit: { count: 1, per: 'hour' } }),
    ]);
    const permdock = await dock([once], 'member', { limits });
    expect(permdock.filter(permissions.report.export, [report])).toEqual([
      report,
    ]);
    const batch = permdock.simulate([[permissions.report.export, report]]);
    expect(Array.isArray(batch)).toBe(true);
    if (Array.isArray(batch)) {
      expect(batch[0]?.outcome).toBe('granted');
    }
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'denied',
    );
  });

  it('does not consume an approval-required quota grant', async () => {
    const limits = memoryLimitStore();
    const permdock = await dock([approved], 'reviewer', { limits });
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'approval-required',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'approval-required',
    );
  });

  it('ORs a later unlimited allow after a quota miss', async () => {
    const limits = memoryLimitStore();
    const permdock = await dock([fallback], 'staff', { limits });
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
  });

  it('resets the memory window when per elapses', async () => {
    const limits = memoryLimitStore();
    const once = role('member', [
      allow(permissions.report.export, { limit: { count: 1, per: 'hour' } }),
    ]);
    const permdock = await dock([once], 'member', { limits });
    const now = 1_700_000_000;
    expect(
      permdock.decide(permissions.report.export, report, { now }).outcome,
    ).toBe('granted');
    expect(
      permdock.decide(permissions.report.export, report, { now }).outcome,
    ).toBe('denied');
    expect(
      permdock.decide(permissions.report.export, report, {
        now: now + 3600,
      }).outcome,
    ).toBe('granted');
  });

  it('keeps quota grants out of the portable snapshot', async () => {
    const permdock = await dock([limited], 'member', {
      limits: memoryLimitStore(),
    });
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected json snapshot');
    }
    const exportGrant = snapshot.grants.find(
      (grant) => grant.permission === permissions.report.export.key,
    );
    expect(exportGrant?.portable).toBe(false);
    expect(exportGrant).not.toHaveProperty('limit');
  });
});

describe('soft and hard quotas', () => {
  const now = 1_700_000_000;
  const resetsAt = (Math.floor(now / 3600) + 1) * 3600;

  it('carries the remaining quota and the window end on a granted decision', async () => {
    const permdock = await dock([limited], 'member', {
      limits: memoryLimitStore(),
    });
    const first = permdock.decide(permissions.report.export, report, { now });
    expect(first.outcome).toBe('granted');
    if (first.outcome === 'granted') {
      expect(first.quota).toEqual({ remaining: 1, resetsAt });
      expect(first).not.toHaveProperty('obligations');
    }
    const second = permdock.decide(permissions.report.export, report, { now });
    expect(second.outcome === 'granted' && second.quota).toEqual({
      remaining: 0,
      resetsAt,
    });
    const read = permdock.decide(permissions.report.read, report, { now });
    expect(read).not.toHaveProperty('quota');
  });

  it('reports the quota a call would leave when only peeking', async () => {
    const permdock = await dock([limited], 'member', {
      limits: memoryLimitStore(),
    });
    const batch = permdock.simulate([[permissions.report.export, report]]);
    const [peeked] = Array.isArray(batch) ? batch : [];
    expect(peeked?.outcome === 'granted' && peeked.quota).toEqual({
      remaining: 1,
      resetsAt: expect.any(Number),
    });
  });

  it('denies past the count in hard mode, the default', async () => {
    const hard = role('member', [
      allow(permissions.report.export, {
        limit: { count: 1, per: 'hour', mode: 'hard' },
      }),
    ]);
    const permdock = await dock([hard], 'member', {
      limits: memoryLimitStore(),
    });
    expect(
      permdock.decide(permissions.report.export, report, { now }).outcome,
    ).toBe('granted');
    const over = permdock.decide(permissions.report.export, report, { now });
    expect(over.outcome === 'denied' && over.denials[0]?.reason).toBe('limit');
  });

  it('grants past the count in soft mode with an over-limit obligation', async () => {
    const soft = role('member', [
      allow(permissions.report.export, {
        limit: { count: 1, per: 'hour', mode: 'soft' },
      }),
    ]);
    const permdock = await dock([soft], 'member', {
      limits: memoryLimitStore(),
    });
    const within = permdock.decide(permissions.report.export, report, { now });
    expect(within.outcome === 'granted' && within.obligations).toBeUndefined();
    const over = permdock.decide(permissions.report.export, report, { now });
    expect(over.outcome).toBe('granted');
    if (over.outcome === 'granted') {
      expect(over.obligations).toEqual([{ kind: 'over-limit' }]);
      expect(over.quota).toEqual({ remaining: 0, resetsAt });
    }
    expect(permdock.can(permissions.report.export, report, { now })).toBe(true);
  });

  it('adds a near-limit obligation once usage reaches alertAt', async () => {
    const alerting = role('member', [
      allow(permissions.report.export, {
        limit: { count: 10, per: 'hour', alertAt: 0.7 },
      }),
    ]);
    const permdock = await dock([alerting], 'member', {
      limits: memoryLimitStore(),
    });
    const kinds: (string | undefined)[] = [];
    for (let call = 0; call < 10; call += 1) {
      const decision = permdock.decide(permissions.report.export, report, {
        now,
      });
      kinds.push(
        decision.outcome === 'granted'
          ? (decision.obligations?.[0]?.kind ?? 'none')
          : decision.outcome,
      );
    }
    expect(kinds).toEqual([
      'none',
      'none',
      'none',
      'none',
      'none',
      'none',
      'near-limit',
      'near-limit',
      'near-limit',
      'near-limit',
    ]);
  });

  it('still denies with limit-unavailable in soft mode when the store is down', async () => {
    const soft = role('member', [
      allow(permissions.report.export, {
        limit: { count: 1, per: 'hour', mode: 'soft' },
      }),
    ]);
    const down: LimitStore = {
      consume(): never {
        throw new Error('redis down');
      },
      remaining(): never {
        throw new Error('redis down');
      },
    };
    const noStore = await dock([soft], 'member');
    const unavailable = await dock([soft], 'member', { limits: down });
    for (const permdock of [noStore, unavailable]) {
      const decision = permdock.decide(permissions.report.export, report);
      expect(decision.outcome === 'denied' && decision.denials[0]?.reason).toBe(
        'limit-unavailable',
      );
      expect(permdock.can(permissions.report.export, report)).toBe(false);
    }
  });

  it('keeps mode and alertAt on the grant and drops unknown limit keys', () => {
    const [grant] = [
      allow(permissions.report.export, {
        // SAFETY: a deliberately unknown extra key, which allow() must drop.
        limit: {
          count: 5,
          per: 'day',
          mode: 'soft',
          alertAt: 0.8,
          extra: true,
        } as never,
      }),
    ].flat();
    expect(grant?.limit).toEqual({
      count: 5,
      per: 'day',
      mode: 'soft',
      alertAt: 0.8,
    });
  });

  it('rejects an unknown mode or an alertAt outside (0, 1]', () => {
    // SAFETY: a deliberately unknown mode, to exercise allow()'s validation.
    expect(() =>
      allow(permissions.report.export, {
        limit: { count: 1, per: 'hour', mode: 'lenient' as never },
      }),
    ).toThrow(/mode/u);
    for (const alertAt of [0, 1.5, -0.2, Number.NaN]) {
      expect(() =>
        allow(permissions.report.export, {
          limit: { count: 1, per: 'hour', alertAt },
        }),
      ).toThrow(/alertAt/u);
    }
    expect(() =>
      allow(permissions.report.export, {
        limit: { count: 1, per: 'hour', alertAt: 1 },
      }),
    ).not.toThrow();
  });
});

describe('quota windows and keys', () => {
  it('rejects an unknown per at definition time', () => {
    expect(() =>
      allow(permissions.report.export, {
        limit: { count: 1, per: 'fortnight' },
      }),
    ).toThrow(/per/u);
    expect(() =>
      allow(permissions.report.export, { limit: { count: 0, per: 'hour' } }),
    ).toThrow(/count/u);
  });

  it('keeps separate counters per tenant', () => {
    const limits = memoryLimitStore();
    const base = {
      key: 'report.export',
      subjectId: 'u1',
      count: 1,
      per: 'hour',
      now: 0,
    };
    expect(limits.consume({ ...base, tenant: 'acme' })).toEqual({
      remaining: 0,
    });
    expect(limits.consume({ ...base, tenant: 'globex' })).toEqual({
      remaining: 0,
    });
    expect(limits.consume({ ...base, tenant: 'acme' })).toEqual({
      remaining: -1,
    });
  });

  it('forgets windows that have ended', () => {
    const limits = memoryLimitStore();
    const base = {
      key: 'report.export',
      subjectId: 'u1',
      count: 1,
      per: '1 s',
    };
    expect(limits.consume({ ...base, now: 0 })).toEqual({ remaining: 0 });
    expect(limits.consume({ ...base, now: 5 })).toEqual({ remaining: 0 });
    expect(limits.size()).toBe(1);
  });
});
