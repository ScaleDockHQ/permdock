import { redirect } from 'next/navigation';
import { renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  memoryApprovalStore,
  resolveApproval,
} from '../../src/approvals/index.ts';
import { APPROVAL_HEADER } from '../../src/approvals/types.ts';
import { PermDockApprovalRequiredError } from '../../src/core/errors.ts';
import { cacheLifeFor, createPermDock } from '../../src/next/index.ts';
import { Protected } from '../../src/react/protected.tsx';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function subjectState(user: typeof memberUser | null = memberUser) {
  let current: typeof memberUser | null = user;
  return {
    read: (): typeof memberUser | null => current,
    set: (next: typeof memberUser | null): void => {
      current = next;
    },
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('permdock/next', () => {
  beforeAll(() => {
    // What `experimental.authInterrupts` sets at build time.
    vi.stubEnv('__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS', 'true');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the documented factory surface without a module singleton', async () => {
    const first = createPermDock(policy, {
      subject: () => memberUser,
    });
    const second = createPermDock(policy, {
      subject: () => adminUser,
    });

    expect(Object.keys(first).toSorted()).toEqual(
      [
        'PermDockProvider',
        'getPermDock',
        'getPermission',
        'permdockHandler',
        'requireAccess',
      ].toSorted(),
    );

    const member = await first.getPermDock();
    const admin = await second.getPermDock();
    expect(member.can(permissions.post.publish, ownPost)).toBe(false);
    expect(admin.can(permissions.post.publish, ownPost)).toBe(true);
  });

  it('builds equivalent request-scoped instances from one factory', async () => {
    const { getPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });

    const [a, b] = await Promise.all([getPermDock(), getPermDock()]);
    expect(a.can(permissions.post.update, ownPost)).toBe(true);
    expect(b.can(permissions.post.update, ownPost)).toBe(true);
    expect(a.can(permissions.post.publish, ownPost)).toBe(
      b.can(permissions.post.publish, ownPost),
    );
  });

  it('accepts an explicit tenant and falls back to the factory resolver', async () => {
    const { getPermDock } = createPermDock(policy, {
      subject: () => ({
        ...memberUser,
        memberships: [{ tenant: 'acme', roles: ['member'] }],
      }),
      tenant: async () => 'acme',
    });

    const fromFallback = await getPermDock();
    const fromQuery = await getPermDock({ tenant: 'globex' });
    expect(fromFallback.subject.principal?.tenant).toBe('acme');
    expect(fromQuery.subject.principal?.tenant).toBeUndefined();
  });

  it('returns getPermission in the usePermission shape and never throws', async () => {
    const { getPermission } = createPermDock(policy, {
      subject: () => memberUser,
    });

    const allowed = await getPermission(permissions.post.update, ownPost);
    expect(allowed).toEqual({
      allowed: true,
      status: 'ready',
      decision: allowed.decision,
    });
    expect(allowed.decision.outcome).toBe('granted');

    const denied = await getPermission(permissions.post.update, otherPost);
    expect(denied.allowed).toBe(false);
    expect(denied.status).toBe('ready');
    expect(denied.decision.outcome).toBe('denied');
  });

  it('runs the factory onDenied after a per-call handler is omitted', async () => {
    const seen: string[] = [];
    const { getPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      onDenied: (decision) => {
        seen.push(decision.outcome);
      },
    });

    const permdock = await getPermDock();
    expect(() => permdock.assert(permissions.post.publish, ownPost)).toThrow(
      /post.publish/,
    );
    expect(seen).toEqual(['denied']);
  });

  it('resolves requireAccess to the granted decision', async () => {
    const { requireAccess } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const decision = await requireAccess({
      permission: permissions.post.update,
      data: ownPost,
    });
    expect(decision.outcome).toBe('granted');
  });

  it('interrupts a denial with forbidden for a subject and unauthorized for anonymous', async () => {
    const seen: string[] = [];
    const member = createPermDock(policy, {
      subject: () => memberUser,
      onDenied: () => {
        seen.push('factory');
      },
    });
    const anonymous = createPermDock(policy, { subject: () => null });

    await expect(
      member.requireAccess({
        permission: permissions.post.update,
        data: otherPost,
      }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;403' });
    await expect(
      anonymous.requireAccess({ permission: permissions.post.read }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;401' });
    expect(seen).toEqual([]);
  });

  it('throws the approval error from requireAccess instead of forbidden', async () => {
    const { requireAccess } = createPermDock(policy, {
      subject: () => memberUser,
      store: memoryApprovalStore(),
    });
    await expect(
      requireAccess({ permission: permissions.post.delete, data: ownPost }),
    ).rejects.toBeInstanceOf(PermDockApprovalRequiredError);
  });

  it('rethrows a Next.js interrupt from the subject resolver instead of going anonymous', async () => {
    const { getPermDock } = createPermDock(policy, {
      subject: () => redirect('/login'),
    });
    await expect(getPermDock()).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });

    const failing = createPermDock(policy, {
      subject: () => {
        throw new Error('no session');
      },
    });
    expect((await failing.getPermDock()).subject.principal).toBeNull();
  });

  it('still writes decisions to the sink outside a request scope', async () => {
    const written: unknown[] = [];
    let flushed = 0;
    const { getPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      sink: {
        write: async (events) => {
          written.push(...events);
        },
        flush: async () => {
          flushed += 1;
        },
      },
    });
    const permdock = await getPermDock();
    permdock.decide(permissions.post.update, ownPost);
    await Promise.resolve();
    expect(written).toHaveLength(1);
    expect(flushed).toBe(0);
  });

  it('answers AuthZEN evaluations from the session subject, not the body', async () => {
    const users = subjectState(memberUser);
    const { permdockHandler } = createPermDock(policy, {
      subject: () => users.read(),
    });
    const { POST } = permdockHandler();

    const forged = await POST(
      new Request('https://app.example/api/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: { type: 'user', id: 'u2' },
          evaluations: [
            {
              resource: { type: 'post', id: 'p1', properties: ownPost },
              action: { name: 'publish' },
            },
            {
              resource: { type: 'post', id: 'p1', properties: ownPost },
              action: { name: 'post.update' },
            },
          ],
        }),
      }),
    );

    expect(forged.status).toBe(200);
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await json(forged)) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly permdock: { readonly outcome: string } };
      }[];
    };
    expect(body.evaluations).toHaveLength(2);
    expect(body.evaluations[0]?.decision).toBe(false);
    expect(body.evaluations[0]?.context.permdock.outcome).toBe('denied');
    expect(body.evaluations[1]?.decision).toBe(true);
    expect(body.evaluations[1]?.context.permdock.outcome).toBe('granted');
  });

  it('fails closed on unknown actions and malformed evaluation bodies', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const { POST } = permdockHandler();

    const unknown = await POST(
      new Request('https://app.example/api/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            { resource: { type: 'post' }, action: { name: 'explode' } },
          ],
        }),
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const unknownBody = (await json(unknown)) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly permdock: { readonly outcome: string } };
      }[];
    };
    expect(unknownBody.evaluations[0]?.decision).toBe(false);
    expect(unknownBody.evaluations[0]?.context.permdock.outcome).toBe('denied');

    const bad = await POST(
      new Request('https://app.example/api/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('refreshes a snapshot on GET and serves AuthZEN discovery', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
      tenant: 'o1',
    });
    const { GET } = permdockHandler();

    const snapshot = await GET(new Request('https://app.example/api/permdock'));
    expect(snapshot.status).toBe(200);
    // SAFETY: snapshot JSON produced by permdockHandler under test.
    const payload = (await json(snapshot)) as {
      readonly v: number;
      readonly grants: readonly { readonly permission: string }[];
    };
    expect(payload.v).toBe(1);
    expect(
      payload.grants.some((grant) => grant.permission === 'post.update'),
    ).toBe(true);

    const discovery = await GET(
      new Request('https://app.example/.well-known/authzen-configuration'),
    );
    // SAFETY: discovery JSON produced by permdockHandler under test.
    const meta = (await json(discovery)) as {
      readonly access_evaluations_endpoint: string;
    };
    expect(meta.access_evaluations_endpoint).toContain(
      '/access/v1/evaluations',
    );
  });

  it('resumes an approved PermDock-Approval header after a fresh decide', async () => {
    const store = memoryApprovalStore();
    const { getPermDock, permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const permdock = await getPermDock();
    const required = permdock.decide(permissions.post.delete, ownPost);
    expect(required.outcome).toBe('approval-required');
    if (required.outcome !== 'approval-required') {
      return;
    }

    const { POST } = permdockHandler();
    const pending = await POST(
      new Request('https://app.example/api/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', id: ownPost.id, properties: ownPost },
              action: { name: 'delete' },
            },
          ],
        }),
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const pendingBody = (await json(pending)) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly permdock: { readonly token?: string } };
      }[];
    };
    expect(pendingBody.evaluations[0]?.decision).toBe(false);
    const token = pendingBody.evaluations[0]?.context.permdock.token;
    expect(token).toBe(required.token);

    await resolveApproval(store, required.token, {
      status: 'approved',
      by: {
        principal: { id: 'u9', roles: ['admin'] },
        context: {},
      },
    });

    const resumed = await POST(
      new Request('https://app.example/api/permdock', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [APPROVAL_HEADER]: required.token,
        },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', id: ownPost.id, properties: ownPost },
              action: { name: 'delete' },
            },
          ],
        }),
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const resumedBody = (await json(resumed)) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly permdock: { readonly outcome: string } };
      }[];
    };
    expect(resumedBody.evaluations[0]?.decision).toBe(true);
    expect(resumedBody.evaluations[0]?.context.permdock.outcome).toBe(
      'granted',
    );
  });

  it('serialises a snapshot through the server PermDockProvider without blocking', async () => {
    const { PermDockProvider } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const guard = (
      <Protected
        permission={permissions.post.update}
        data={ownPost}
        pending={<span>loading</span>}
        fallback={<span>locked</span>}
      >
        <span>edit</span>
      </Protected>
    );
    const shell = renderToString(
      PermDockProvider({ children: [<nav key="nav">nav</nav>, guard] }),
    );
    expect(shell).toContain('nav');
    expect(shell).toContain('loading');
    const { prelude } = await prerender(PermDockProvider({ children: guard }));
    expect(await new Response(prelude).text()).toContain('edit');
  });

  it('fails closed when the subject cannot be resolved', async () => {
    const { PermDockProvider } = createPermDock(policy, {
      subject: () => {
        throw new Error('no session');
      },
    });
    const { prelude } = await prerender(
      PermDockProvider({
        children: (
          <Protected
            permission={permissions.post.update}
            data={ownPost}
            pending={<span>loading</span>}
            fallback={<span>locked</span>}
          >
            <span>edit</span>
          </Protected>
        ),
      }),
    );
    expect(await new Response(prelude).text()).toContain('locked');
  });

  it('refuses to load in a browser', () => {
    vi.stubGlobal('document', {});
    try {
      expect(() =>
        createPermDock(policy, { subject: () => memberUser }),
      ).toThrow(/permdock\/next is server-only/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops a failing tenant resolver and rethrows a Next.js interrupt from it', async () => {
    const failing = createPermDock(policy, {
      subject: () => memberUser,
      tenant: () => {
        throw new Error('no cookie');
      },
    });
    expect((await failing.getPermDock()).subject.principal?.tenant).toBe(
      undefined,
    );
    const redirecting = createPermDock(policy, {
      subject: () => memberUser,
      tenant: () => redirect('/pick-tenant'),
    });
    await expect(redirecting.getPermDock()).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
  });

  it('denies from getPermission when the instance cannot be built', async () => {
    const { getPermission } = createPermDock(policy, {
      subject: () => redirect('/login'),
    });
    expect(await getPermission(permissions.post.read, ownPost)).toEqual({
      allowed: false,
      status: 'ready',
      decision: {
        outcome: 'denied',
        denials: [{ role: null, reason: 'no-grant' }],
        alternatives: [],
      },
    });
  });

  it('checks requireAccess in the requested tenant', async () => {
    const tenants: (string | undefined)[] = [];
    const { requireAccess } = createPermDock(policy, {
      subject: () => memberUser,
      tenant: () => {
        tenants.push('fallback');
        return 'fallback';
      },
    });
    const decision = await requireAccess({
      permission: permissions.post.update,
      data: ownPost,
      tenant: 'acme',
    });
    expect(decision.outcome).toBe('granted');
    expect(tenants).toEqual([]);
  });

  it('renders the tenant-scoped provider and fails closed when the instance throws', async () => {
    const scoped = createPermDock(policy, { subject: () => memberUser });
    const guard = (
      <Protected
        permission={permissions.post.update}
        data={ownPost}
        pending={<span>loading</span>}
        fallback={<span>locked</span>}
      >
        <span>edit</span>
      </Protected>
    );
    const tenantRun = await prerender(
      scoped.PermDockProvider({ tenant: 'o1', children: guard }),
    );
    expect(await new Response(tenantRun.prelude).text()).toContain('edit');
    const interrupted = createPermDock(policy, {
      subject: () => redirect('/login'),
    });
    const { prelude } = await prerender(
      interrupted.PermDockProvider({ children: guard }),
    );
    expect(await new Response(prelude).text()).toContain('locked');
  });

  it('writes to a sink without flush and with synchronous writes', async () => {
    const written: unknown[] = [];
    const { getPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      sink: {
        write: (events) => {
          written.push(...events);
        },
      },
    });
    const permdock = await getPermDock();
    permdock.decide(permissions.post.update, ownPost);
    expect(written).toHaveLength(1);
  });
});

describe('cacheLifeFor', () => {
  it('reads the clock without issuedAt or now', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      expect(cacheLifeFor({ expiresAt: 1060 })).toEqual({ stale: 60 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses max for values that never expire', () => {
    expect(cacheLifeFor(null)).toEqual({ stale: 300 });
    expect(cacheLifeFor({ issuedAt: 100 })).toEqual({ stale: 300 });
    expect(cacheLifeFor({ expiresAt: null }, { max: 600 })).toEqual({
      stale: 600,
    });
  });

  it('never serves past expiresAt and reads the clock from issuedAt', () => {
    expect(cacheLifeFor({ issuedAt: 1000, expiresAt: 1120 })).toEqual({
      stale: 120,
    });
    expect(cacheLifeFor({ issuedAt: 1000, expiresAt: 5000 })).toEqual({
      stale: 300,
    });
    expect(cacheLifeFor({ issuedAt: 1000, expiresAt: 1010 })).toEqual({
      stale: 10,
    });
    expect(cacheLifeFor({ issuedAt: 1000, expiresAt: 900 })).toEqual({
      stale: 0,
    });
    expect(cacheLifeFor({ expiresAt: 1100 }, { now: 1000, min: 60 })).toEqual({
      stale: 100,
    });
  });
});
