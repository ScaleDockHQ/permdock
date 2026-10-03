import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LimitStore } from '../../src/core/interfaces.ts';

import { memoryLimitStore } from '../../src/core/limits.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';

const Report = z.object({ id: z.string() });

const permissions = definePermissions({
  report: resource(Report, {
    id: 'id',
    actions: ['export', 'delete'],
  }),
});

const report = { id: 'r1' };

const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.report.export, { limit: { count: 2, per: 'hour' } }),
    ]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

function member(limits: LimitStore) {
  return createPermDock(policy, { id: 'u1', roles: ['member'] }, { limits });
}

describe('alternatives on a denial', () => {
  it('lists a quota grant as an alternative without spending its quota', async () => {
    const permdock = await member(memoryLimitStore());
    const denied = permdock.decide(permissions.report.delete, report);
    expect(denied).toMatchObject({
      outcome: 'denied',
      alternatives: [expect.objectContaining({ key: 'report.export' })],
    });
    permdock.decide(permissions.report.delete, report);
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'granted',
    );
    expect(permdock.decide(permissions.report.export, report).outcome).toBe(
      'denied',
    );
  });

  it('skips alternatives for can, which only reads the outcome', async () => {
    let reads = 0;
    const store = memoryLimitStore();
    const counting: LimitStore = {
      consume: (input) => store.consume(input),
      remaining: (input) => {
        reads += 1;
        return store.remaining(input);
      },
    };
    const permdock = await member(counting);
    expect(permdock.can(permissions.report.delete, report)).toBe(false);
    expect(reads).toBe(0);
  });
});
