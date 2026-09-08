import { describe, expect, it } from 'vitest';

import type { Subject } from './subject.ts';

import {
  matchScopedMembership,
  resolveActiveTenant,
  tenantsOf,
} from './tenancy.ts';

describe('tenancy', () => {
  it('never defaults the active tenant', () => {
    const principal = {
      id: 'u1',
      memberships: [{ tenant: 'o1', roles: ['viewer'] }],
    };
    expect(resolveActiveTenant(principal, 'o2')).toBeUndefined();
    expect(resolveActiveTenant(principal, 'o1')).toBe('o1');
    expect(tenantsOf(principal)).toEqual(['o1']);
  });

  it('matches tenant, team and expired memberships', () => {
    const now = 1000;
    const subject: Subject = {
      principal: {
        id: 'u1',
        tenant: 'o1',
        memberships: [
          { tenant: 'o1', roles: ['viewer'] },
          { tenant: 'o1', team: 't1', roles: ['lead'] },
          { tenant: 'o1', roles: ['stale'], expiresAt: 10 },
        ],
      },
      context: {},
    };
    expect(
      matchScopedMembership(
        subject,
        'tenant',
        'viewer',
        { orgId: 'o1' },
        { tenant: { key: 'orgId' } },
        undefined,
        now,
      ).ok,
    ).toBe(true);
    expect(
      matchScopedMembership(
        subject,
        'team',
        'lead',
        { teamId: 't1' },
        { team: { key: 'teamId' } },
        undefined,
        now,
      ).ok,
    ).toBe(true);
    const expired = matchScopedMembership(
      subject,
      'tenant',
      'stale',
      { orgId: 'o1' },
      { tenant: { key: 'orgId' } },
      undefined,
      now,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.reason).toBe('expired-membership');
    }
  });
});
