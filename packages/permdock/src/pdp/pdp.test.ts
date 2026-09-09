import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createPermDock as createCore } from '../core/permdock.ts';
import { definePermissions, resource } from '../core/permissions.ts';
import { allow, definePolicy, deny, role } from '../core/policy.ts';
import { createPermDock, remotePdp } from './index.ts';

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
            context: { outcome: 'approval-required', token: 'pd1.remote' },
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
});
