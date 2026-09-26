import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LimitStore } from './interfaces.ts';

import { memoryLimitStore } from './limits.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, role } from './policy.ts';

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
  roles: Parameters<typeof definePolicy>[1]['roles'],
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
  roles: Parameters<typeof definePolicy>[1]['roles'],
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
