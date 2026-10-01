import { describe, expect, it } from 'vitest';

import type { GrantLimit } from '../../src/core/policy.ts';

import {
  applyQuota,
  assertLimit,
  memoryLimitStore,
} from '../../src/core/limits.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';

const permissions = definePermissions({
  report: resource({ id: 'id', actions: ['export'] }),
});

const NOW = 1_800_000_000;

function quota(
  limit: GrantLimit,
  overrides: Partial<Parameters<typeof applyQuota>[0]> = {},
) {
  return applyQuota({
    store: memoryLimitStore(),
    cache: new Map(),
    grant: {
      permission: permissions.report.export,
      effect: 'allow',
      to: { kind: 'anyone' },
      role: null,
      portable: true,
      scope: 'global',
      limit,
    },
    permissionKey: 'report.export',
    subjectId: 'u1',
    tenant: undefined,
    now: NOW,
    consume: false,
    ...overrides,
  });
}

describe('assertLimit windows', () => {
  it.each([
    { per: 'hour', valid: true },
    { per: ' 15 MIN ', valid: true },
    { per: '2 days', valid: true },
    { per: '0 min', valid: false },
    { per: '3 fortnights', valid: false },
    { per: 'sometimes', valid: false },
  ])('accepts $per: $valid', ({ per, valid }) => {
    let message = '';
    try {
      assertLimit({ count: 1, per }, 'report.export');
    } catch (error) {
      message = String(error);
    }
    expect(message.includes('is not a duration')).toBe(!valid);
  });
});

describe('memoryLimitStore', () => {
  const input = { key: 'k', subjectId: 'u1', count: 2, per: 'hour', now: NOW };

  it.each([
    { name: 'an unknown window', change: { per: 'sometimes' } },
    { name: 'a zero count', change: { count: 0 } },
    { name: 'an infinite count', change: { count: Number.POSITIVE_INFINITY } },
  ])('fails closed on $name', ({ change }) => {
    const store = memoryLimitStore();
    expect({
      consumed: store.consume({ ...input, ...change }),
      peeked: store.remaining({ ...input, ...change }),
      size: store.size(),
    }).toEqual({
      consumed: { remaining: -1 },
      peeked: { remaining: -1 },
      size: 0,
    });
  });

  it('sweeps only the counters whose window has passed', () => {
    const store = memoryLimitStore();
    store.consume({ ...input, key: 'minute', per: 'minute' });
    store.consume({ ...input, key: 'day', per: 'day' });
    store.consume({ ...input, key: 'later', per: 'hour', now: NOW + 120 });
    expect(store.size()).toBe(2);
  });

  it('counts against the clock when no time is given', () => {
    const store = memoryLimitStore();
    const { now: _now, ...live } = input;
    expect([store.consume(live), store.remaining(live)]).toEqual([
      { remaining: 1 },
      { remaining: 1 },
    ]);
  });
});

describe('applyQuota peeking', () => {
  const limit = { count: 3, per: 'hour' };

  it('refuses a window no store can count', () => {
    expect(quota({ count: 3, per: 'sometimes' })).toEqual({
      ok: false,
      reason: 'limit-unavailable',
    });
  });

  it('falls back to the request cache when the store cannot peek', () => {
    const store = {
      consume: () => ({ remaining: 0 }),
      remaining: () => undefined,
    };
    const cache = new Map<string, number>();
    const missing = quota(limit, { store, cache });
    cache.set(
      JSON.stringify([
        null,
        'u1',
        'report.export',
        'hour',
        String(Math.floor(NOW / 3600)),
      ]),
      2,
    );
    const cached = quota(limit, { store, cache });
    expect({ missing, cached }).toEqual({
      missing: { ok: false, reason: 'limit-unavailable' },
      cached: {
        ok: true,
        quota: { remaining: 1, resetsAt: (Math.floor(NOW / 3600) + 1) * 3600 },
      },
    });
  });
});
