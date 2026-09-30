import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createPermDock as createCore } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { createPermDock, remotePdp } from '../../src/pdp/index.ts';

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'delete'],
    collection: ['list'],
  }),
  billing: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['invoice'],
  }),
});

const post = { id: 'p1', authorId: 'user-1' };

function policyWith(
  providers: Parameters<typeof definePolicy>[1]['providers'],
) {
  return definePolicy(permissions, {
    roles: [
      role('member', [
        allow(permissions.post.read),
        allow(permissions.post.list),
        deny(permissions.post.delete),
      ]),
    ],
    subject: (user: {
      readonly id: string;
      readonly roles: readonly string[];
    }) => user,
    providers,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('permdock/pdp', () => {
  it('fails closed in core createPermDock for delegated permissions', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () => jsonResponse({ decision: true }),
      }),
    ]);
    const dock = await createCore(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    expect(dock.can(permissions.post.read, post)).toBe(false);
    expect(dock.decide(permissions.post.read, post).denials[0]?.reason).toBe(
      'pdp-unavailable',
    );
  });

  it('short-circuits an explicit local deny without a network call', async () => {
    let calls = 0;
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () => {
          calls += 1;
          return jsonResponse({ decision: true });
        },
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    const decision = await dock.decide(permissions.post.delete, post);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('deny');
    expect(calls).toBe(0);
  });

  it('intersects a local grant with a remote true', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () => jsonResponse({ decision: true }),
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    await expect(dock.can(permissions.post.read, post)).resolves.toBe(true);
  });

  it('denies when the remote returns false', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () => jsonResponse({ decision: false }),
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    const decision = await dock.decide(permissions.post.read, post);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('pdp-denied');
  });

  it('asks the remote when a delegated permission has no local grant', async () => {
    const policy = definePolicy(permissions, {
      roles: [role('member', [allow(permissions.post.read)])],
      subject: (user: {
        readonly id: string;
        readonly roles: readonly string[];
      }) => user,
      providers: [
        remotePdp({
          url: 'https://pdp.example',
          permissions: [permissions.billing],
          endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
          fetch: async () => jsonResponse({ decision: true }),
        }),
      ],
    });
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    await expect(
      dock.can(permissions.billing.invoice, { id: 'inv-1' }),
    ).resolves.toBe(true);
    await expect(dock.can(permissions.post.read, post)).resolves.toBe(true);
  });

  it('maps approval-required from the remote context', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () =>
          jsonResponse({
            decision: false,
            context: {
              permdock: { outcome: 'approval-required', token: 'pd1.remote' },
            },
          }),
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    const decision = await dock.decide(permissions.post.read, post);
    expect(decision).toMatchObject({
      outcome: 'approval-required',
      token: 'pd1.remote',
    });
  });

  it('fails closed on timeout, non-2xx and unknown shapes', async () => {
    const cases: readonly {
      readonly fetch: typeof fetch;
      readonly reason: string;
    }[] = [
      {
        fetch: async () => {
          throw new Error('timeout');
        },
        reason: 'pdp-unavailable',
      },
      {
        fetch: async () => jsonResponse({ decision: true }, 503),
        reason: 'pdp-unavailable',
      },
      {
        fetch: async () => jsonResponse({ ok: true }),
        reason: 'pdp-invalid-response',
      },
    ];
    for (const item of cases) {
      const policy = policyWith([
        remotePdp({
          url: 'https://pdp.example',
          endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
          fetch: item.fetch,
        }),
      ]);
      const dock = await createPermDock(policy, {
        id: 'user-1',
        roles: ['member'],
      });
      const decision = await dock.decide(permissions.post.read, post);
      expect(decision.outcome).toBe('denied');
      expect(decision.denials[0]?.reason).toBe(item.reason);
    }
  });

  it('caches identical successful decisions within ttl', async () => {
    let calls = 0;
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        cache: { ttl: '5s' },
        fetch: async () => {
          calls += 1;
          return jsonResponse({ decision: true });
        },
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    await dock.can(permissions.post.read, post);
    await dock.can(permissions.post.read, post);
    expect(calls).toBe(1);
  });

  it('never lets a remote grant exceed a local delegation miss', async () => {
    const policy = definePolicy(permissions, {
      roles: [role('member', [allow(permissions.post.read)])],
      subject: (user: {
        readonly id: string;
        readonly roles: readonly string[];
      }) => user,
      providers: [
        remotePdp({
          url: 'https://pdp.example',
          endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
          fetch: async () => jsonResponse({ decision: true }),
        }),
      ],
    });
    const dock = await createPermDock(
      policy,
      { id: 'user-1', roles: ['member'] },
      {
        actor: { id: 'agent-1', kind: 'mcp-client' },
        delegation: { scopes: [] },
      },
    );
    const decision = await dock.decide(permissions.post.read, post);
    expect(decision.outcome).toBe('denied');
    expect(decision.denials[0]?.reason).toBe('no-delegation');
  });

  it('keys the cache by tenant, so one tenant never reuses another tenant grant', async () => {
    const policy = definePolicy(permissions, {
      roles: [role('member', [allow(permissions.post.read)])],
      subject: (user: {
        readonly id: string;
        readonly roles: readonly string[];
        readonly memberships: readonly {
          readonly tenant: string;
          readonly roles: readonly string[];
        }[];
      }) => user,
      providers: [
        remotePdp({
          url: 'https://pdp.example',
          endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
          cache: { ttl: '5s' },
          fetch: async (_url, init) => {
            // SAFETY: remotePdp posts an AuthZEN evaluation request as a JSON object body.
            const body = JSON.parse(String(init?.body)) as {
              readonly context?: { readonly tenant?: string };
            };
            return jsonResponse({ decision: body.context?.tenant === 'acme' });
          },
        }),
      ],
    });
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
      memberships: [
        { tenant: 'acme', roles: ['member'] },
        { tenant: 'globex', roles: ['member'] },
      ],
    });
    expect(await dock.tenant('acme').can(permissions.post.read, post)).toBe(
      true,
    );
    expect(await dock.tenant('globex').can(permissions.post.read, post)).toBe(
      false,
    );
  });

  it('re-asks the remote when the row changes under the same id', async () => {
    let calls = 0;
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        cache: { ttl: '5s' },
        fetch: async () => {
          calls += 1;
          return jsonResponse({ decision: true });
        },
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    await dock.can(permissions.post.read, post);
    await dock.can(permissions.post.read, { ...post, authorId: 'user-2' });
    expect(calls).toBe(2);
  });

  it('returns an always-false partial where when the provider cannot list', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () => jsonResponse({ decision: true }),
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    expect(await dock.where(permissions.post.read)).toEqual({
      condition: { op: 'or', conditions: [] },
      partial: true,
    });
  });

  it('filters and compiles where from AuthZEN resource search ids', async () => {
    const bodies: unknown[] = [];
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: {
          evaluation: 'https://pdp.example/access/v1/evaluation',
          searchResource: 'https://pdp.example/access/v1/search/resource',
        },
        fetch: async (_url, init) => {
          // SAFETY: remotePdp posts an AuthZEN request as a JSON object body.
          const body = JSON.parse(String(init?.body)) as {
            readonly page?: unknown;
          };
          bodies.push(body);
          return body.page === undefined
            ? jsonResponse({
                results: [{ type: 'post', id: 'p1' }],
                page: { next_token: 'n1' },
              })
            : jsonResponse({ results: [{ type: 'post', id: 'p3' }] });
        },
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    const rows = [
      { id: 'p1', authorId: 'a' },
      { id: 'p2', authorId: 'a' },
      { id: 'p3', authorId: 'a' },
    ];
    expect(
      (await dock.filter(permissions.post.read, rows)).map((row) => row.id),
    ).toEqual(['p1', 'p3']);
    expect(bodies).toHaveLength(2);
    const where = await dock.where(permissions.post.read);
    expect(where.partial).toBe(false);
    expect(where.condition).toEqual({
      op: 'and',
      conditions: [
        expect.anything(),
        { op: 'in', field: 'id', value: ['p1', 'p3'] },
      ],
    });
    expect(bodies).toHaveLength(4);
  });

  it('denies every row when resource search fails', async () => {
    const policy = policyWith([
      remotePdp({
        url: 'https://pdp.example',
        endpoints: {
          evaluation: 'https://pdp.example/access/v1/evaluation',
          searchResource: 'https://pdp.example/access/v1/search/resource',
        },
        fetch: async () => jsonResponse({ results: [{ id: 'p1' }] }),
      }),
    ]);
    const dock = await createPermDock(policy, {
      id: 'user-1',
      roles: ['member'],
    });
    expect(await dock.filter(permissions.post.read, [post])).toEqual([]);
    expect(await dock.where(permissions.post.read)).toEqual({
      condition: { op: 'or', conditions: [] },
      partial: false,
    });
  });

  it('caps the cache TTL at 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const policy = policyWith([
        remotePdp({
          url: 'https://pdp.example',
          endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
          cache: { ttl: '300s' },
          fetch: async () => {
            calls += 1;
            return jsonResponse({ decision: true });
          },
        }),
      ]);
      const dock = await createPermDock(policy, {
        id: 'user-1',
        roles: ['member'],
      });
      await dock.decide(permissions.post.read, post);
      vi.advanceTimersByTime(29_000);
      await dock.decide(permissions.post.read, post);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(2000);
      await dock.decide(permissions.post.read, post);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
