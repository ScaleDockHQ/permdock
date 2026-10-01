import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Decision, Denial } from '../../src/core/decision.ts';

import {
  allow,
  definePermissions,
  definePolicy,
  memoryLimitStore,
  resource,
  role,
} from '../../src/index.ts';
import { createPermDock, problemFromDecision } from '../../src/server/index.ts';
import { rateLimitHeaders } from '../../src/server/problem.ts';

type Item = {
  readonly name: string;
  readonly params: Readonly<Record<string, number>>;
};

const SF_STRING = /^"((?:[\u0020\u0021\u0023-\u005B\u005D-\u007E]|\\["\\])*)"/u;
const SF_PARAM = /^;([a-z*][a-z0-9_.*-]*)=(-?\d{1,15})/u;

/** An RFC 9651 List of sf-string Items with integer parameters; throws on anything else. */
function parseList(field: string): readonly Item[] {
  const items: Item[] = [];
  let rest = field;
  while (rest.length > 0) {
    const name = SF_STRING.exec(rest);
    if (name === null) {
      throw new Error(`not an sf-string: ${rest}`);
    }
    rest = rest.slice(name[0].length);
    const params: Record<string, number> = {};
    for (
      let param = SF_PARAM.exec(rest);
      param !== null;
      param = SF_PARAM.exec(rest)
    ) {
      params[param[1] ?? ''] = Number(param[2]);
      rest = rest.slice(param[0].length);
    }
    items.push({ name: (name[1] ?? '').replaceAll(/\\(.)/gu, '$1'), params });
    if (rest.length === 0) {
      break;
    }
    const separator = /^[ \t]*,[ \t]*/u.exec(rest);
    if (separator === null) {
      throw new Error(`no list separator: ${rest}`);
    }
    rest = rest.slice(separator[0].length);
  }
  return items;
}

const Report = z.object({ id: z.string() });
const permissions = definePermissions({
  report: resource(Report, { actions: ['read', 'export'] }),
});

type User = { readonly id: string; readonly roles: readonly string[] };

function limited(denials: readonly Denial[]): Decision {
  return { outcome: 'denied', denials, alternatives: [] };
}

const NOW = 1_000_000;

describe('RateLimit header fields (draft-ietf-httpapi-ratelimit-headers)', () => {
  it('answers an exhausted grant with 429, Retry-After and both fields', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.report.export, { limit: { count: 2, per: 'day' } }),
        ]),
      ],
      subject: (user: User) => user,
    });
    const { protect } = createPermDock(policy, {
      subject: () => ({ id: 'u1', roles: ['member'] }),
      limits: memoryLimitStore(),
    });
    const guard = protect(permissions.report.export);
    const request = (): Request => new Request('https://api.example/reports');
    expect((await guard(request())).ok).toBe(true);
    expect((await guard(request())).ok).toBe(true);
    const refused = await guard(request());
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    const { headers } = refused.response;
    expect(refused.response.status).toBe(429);
    const retryAfter = headers.get('Retry-After') ?? '';
    expect(retryAfter).toMatch(/^[1-9]\d*$/u);
    const [policyItem] = parseList(headers.get('RateLimit-Policy') ?? '');
    const [limitItem] = parseList(headers.get('RateLimit') ?? '');
    expect(policyItem).toEqual({ name: 'member', params: { q: 2, w: 86_400 } });
    expect(limitItem).toEqual({
      name: 'member',
      params: { r: 0, t: Number(retryAfter) },
    });
  });

  it('names one policy per exhausted role and retries after the soonest reset', () => {
    const headers = rateLimitHeaders(
      limited([
        {
          role: 'member',
          reason: 'limit',
          detail: { count: 100, window: 86_400, resetsAt: NOW + 3600 },
        },
        {
          role: null,
          reason: 'limit',
          detail: { count: 10, window: 60, resetsAt: NOW + 20 },
        },
        {
          role: 'member',
          reason: 'limit',
          detail: { count: 5, window: 60, resetsAt: NOW + 5 },
        },
      ]),
      NOW,
    );
    expect(parseList(headers['RateLimit-Policy'] ?? '')).toEqual([
      { name: 'member', params: { q: 100, w: 86_400 } },
      { name: 'default', params: { q: 10, w: 60 } },
    ]);
    expect(parseList(headers['RateLimit'] ?? '')).toEqual([
      { name: 'member', params: { r: 0, t: 3600 } },
      { name: 'default', params: { r: 0, t: 20 } },
    ]);
    expect(headers['Retry-After']).toBe('20');
  });

  it('never sends a reset below one second', () => {
    const headers = rateLimitHeaders(
      limited([
        {
          role: 'member',
          reason: 'limit',
          detail: { count: 1, window: 60, resetsAt: NOW - 10 },
        },
      ]),
      NOW,
    );
    expect(headers['Retry-After']).toBe('1');
    expect(parseList(headers['RateLimit'] ?? '')[0]?.params['t']).toBe(1);
  });

  it('serialises any role name as a valid sf-string', () => {
    for (const name of [
      'say "hi"',
      'back\\slash',
      'élève',
      '管理者',
      '\u{1F600}',
      '\uD800',
    ]) {
      const headers = rateLimitHeaders(
        limited([
          {
            role: name,
            reason: 'limit',
            detail: { count: 1, window: 60, resetsAt: NOW + 1 },
          },
        ]),
        NOW,
      );
      const [item] = parseList(headers['RateLimit-Policy'] ?? '');
      expect(item?.params).toEqual({ q: 1, w: 60 });
      expect(/^[\u0020-\u007E]*$/u.test(item?.name ?? '\n')).toBe(true);
    }
    const [quotes] = parseList(
      rateLimitHeaders(
        limited([
          {
            role: 'say "hi"',
            reason: 'limit',
            detail: { count: 1, window: 60, resetsAt: NOW + 1 },
          },
        ]),
        NOW,
      )['RateLimit-Policy'] ?? '',
    );
    expect(quotes?.name).toBe('say "hi"');
  });

  it('sends no fields for a granted decision, a limit-free denial or a malformed detail', () => {
    expect(
      rateLimitHeaders(limited([{ role: 'member', reason: 'condition' }]), NOW),
    ).toEqual({});
    expect(
      rateLimitHeaders(
        limited([{ role: 'member', reason: 'limit', detail: { count: 'x' } }]),
        NOW,
      ),
    ).toEqual({});
    expect(
      rateLimitHeaders(
        limited([{ role: 'member', reason: 'limit', detail: null }]),
        NOW,
      ),
    ).toEqual({});
  });

  it('keeps a 403 when another denial is not a limit, and a 503 without Retry-After when the store fails', async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('member', [
          allow(permissions.report.export, {
            limit: { count: 1, per: 'hour' },
          }),
        ]),
        role('viewer', [allow(permissions.report.read)]),
      ],
      subject: (user: User) => user,
    });
    const failing = createPermDock(policy, {
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    const unavailable = await failing.protect(permissions.report.export)(
      new Request('https://api.example/reports'),
    );
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) {
      return;
    }
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.response.headers.get('Retry-After')).toBeNull();
    expect(unavailable.response.headers.get('RateLimit')).toBeNull();

    const mixed = problemFromDecision(
      limited([
        {
          role: 'member',
          reason: 'limit',
          detail: { count: 1, window: 60, resetsAt: NOW + 1 },
        },
        { role: 'viewer', reason: 'condition' },
      ]),
      permissions.report.export,
      { principal: null, context: {} },
    );
    expect(mixed.status).toBe(403);
    expect(mixed.headers.get('Retry-After')).toBeNull();
    expect(mixed.headers.get('RateLimit')).toBeNull();
  });
});
