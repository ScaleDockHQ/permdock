import { Suspense } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '../../src/core/from-snapshot.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { approvalHeaders } from '../../src/react/headers.ts';
import {
  useAssignablePermissions,
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from '../../src/react/hooks.ts';
import { Protected } from '../../src/react/protected.tsx';
import { PermDockProvider } from '../../src/react/provider.tsx';
import { createClientStore } from '../../src/react/store.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { alice, policy as saasPolicy } from '../fixtures/saas.ts';

async function memberSnapshot() {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error('expected JSON snapshot');
  }
  return snapshot;
}

function Probe(): string {
  const { allowed } = usePermission(permissions.post.update, ownPost);
  const actions = usePermissions(
    [permissions.post.update, permissions.post.publish],
    ownPost,
  );
  const editable = useFilter(permissions.post.update, [ownPost, otherPost]);
  const tenant = useTenant();
  const memberships = useMemberships();
  const { roles } = useRoles();
  const subject = useSubject();
  const dock = usePermDock();
  return `${allowed}:${actions.granted.length}:${editable.length}:${editable.partial}:${tenant.tenant ?? 'none'}:${memberships.length}:${roles.map((item) => item.key).join(',')}:${subject.simulated}:${dock.status()}`;
}

function AssignableProbe(): string {
  const leaves = useAssignablePermissions();
  const other = useAssignablePermissions({ tenant: 'globex' });
  return `${leaves.map((leaf) => leaf.key).join(',')}|${other.length}`;
}

describe('useAssignablePermissions', () => {
  it('reads the custom-role ceiling the subject may hand out from the snapshot', async () => {
    const server = await createPermDock(saasPolicy, alice, { tenant: 'acme' });
    const snapshot = server.snapshot({ tenants: 'all' });
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const html = renderToStaticMarkup(
      <PermDockProvider snapshot={snapshot}>
        <AssignableProbe />
      </PermDockProvider>,
    );
    const [acme = '', globex] = html.split('|');
    expect(acme.split(',')).toContain('project.update');
    expect(acme.split(',')).not.toContain('billing.read');
    expect(Number(globex)).toBeGreaterThan(0);
    expect(acme.split(',')).toEqual(
      server.assignablePermissions().map((leaf) => leaf.key),
    );
  });
});

describe('permdock/react', () => {
  it('renders portable grants from the snapshot without flashing deny', async () => {
    const snapshot = await memberSnapshot();
    const html = renderToStaticMarkup(
      <PermDockProvider snapshot={snapshot}>
        <Protected
          permission={permissions.post.update}
          data={ownPost}
          fallback={<span>locked</span>}
        >
          <span>edit</span>
        </Protected>
        <Protected
          permission={permissions.post.update}
          data={otherPost}
          fallback={<span>locked</span>}
        >
          <span>edit</span>
        </Protected>
      </PermDockProvider>,
    );
    expect(html).toContain('edit');
    expect(html).toContain('locked');
  });

  it('exposes snapshot introspection through hooks', async () => {
    const snapshot = await memberSnapshot();
    const html = renderToStaticMarkup(
      <PermDockProvider snapshot={snapshot}>
        <span>
          <Probe />
        </span>
      </PermDockProvider>,
    );
    expect(html).toContain('true:1:1:false');
    expect(html).toContain('member');
    expect(html).toContain('false:ready');
  });

  it('marks closure grants server-only without an endpoint', async () => {
    const snapshot = await memberSnapshot();
    const store = createClientStore({
      snapshot: {
        ...snapshot,
        grants: snapshot.grants.map((grant) =>
          grant.permission === 'post.update'
            ? {
                permission: grant.permission,
                effect: grant.effect,
                role: grant.role,
                to: grant.to,
                portable: false as const,
              }
            : grant,
        ),
      },
    });
    const state = store.permissionState(permissions.post.update, ownPost);
    expect(state.allowed).toBe(false);
    expect(state.status).toBe('server-only');
  });

  it('never calls the endpoint while rendering on the server', async () => {
    const snapshot = await memberSnapshot();
    let calls = 0;
    const store = createClientStore({
      snapshot: {
        ...snapshot,
        grants: snapshot.grants.map((grant) =>
          grant.permission === 'post.update'
            ? {
                permission: grant.permission,
                effect: grant.effect,
                role: grant.role,
                to: grant.to,
                portable: false as const,
              }
            : grant,
        ),
      },
      endpoint: '/api/permdock',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    expect(
      store.permissionState(permissions.post.update, ownPost),
    ).toMatchObject({ allowed: false, status: 'pending' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(0);
  });

  it('batches endpoint evaluations and caches by resource id', async () => {
    const snapshot = await memberSnapshot();
    const calls: unknown[] = [];
    const store = createClientStore({
      snapshot: {
        ...snapshot,
        grants: snapshot.grants.map((grant) =>
          grant.permission === 'post.update'
            ? {
                permission: grant.permission,
                effect: grant.effect,
                role: grant.role,
                to: grant.to,
                portable: false as const,
              }
            : grant,
        ),
      },
      endpoint: '/api/permdock',
      server: false,
      fetch: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            evaluations: [
              {
                decision: true,
                context: {
                  permdock: {
                    outcome: 'granted',
                    subject: {
                      principal: { id: 'u1', roles: ['member'] },
                      context: {},
                    },
                    matched: { role: 'member', permission: 'post.update' },
                    token: 'pd1.x',
                  },
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    expect(store.permissionState(permissions.post.update, ownPost).status).toBe(
      'pending',
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Promise.resolve();
      if (
        store.permissionState(permissions.post.update, ownPost).status ===
        'ready'
      ) {
        break;
      }
    }
    const ready = store.permissionState(permissions.post.update, ownPost);
    expect(ready.status).toBe('ready');
    expect(ready.allowed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not read the clock while a snapshotPromise is pending', () => {
    const never = new Promise<string>(() => {
      // never settles
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      renderToString(
        <PermDockProvider snapshotPromise={never}>
          <nav>static nav</nav>
        </PermDockProvider>,
      );
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('suspends only the readers of a snapshotPromise', async () => {
    const snapshot = await memberSnapshot();
    const never = new Promise<typeof snapshot>(() => {
      // never settles
    });
    const shell = renderToString(
      <PermDockProvider snapshotPromise={never}>
        <nav>static nav</nav>
        <Protected
          permission={permissions.post.update}
          data={ownPost}
          pending={<span>loading</span>}
        >
          <span>edit</span>
        </Protected>
      </PermDockProvider>,
    );
    expect(shell).toContain('static nav');
    expect(shell).toContain('loading');
    expect(shell).not.toContain('edit');

    const { prelude } = await prerender(
      <PermDockProvider snapshotPromise={Promise.resolve(snapshot)}>
        <Protected
          permission={permissions.post.update}
          data={ownPost}
          pending={<span>loading</span>}
          fallback={<span>locked</span>}
        >
          <span>edit</span>
        </Protected>
        <Protected
          permission={permissions.post.update}
          data={otherPost}
          pending={<span>loading</span>}
          fallback={<span>locked</span>}
        >
          <span>edit</span>
        </Protected>
      </PermDockProvider>,
    );
    const html = await new Response(prelude).text();
    expect(html).toContain('edit');
    expect(html).toContain('locked');
    expect(html).not.toContain('loading');
  });

  it('fails closed for an unverifiable JWS from a snapshotPromise', async () => {
    const { prelude } = await prerender(
      <PermDockProvider snapshotPromise={Promise.resolve('a.b.c')}>
        <Suspense fallback="loading">
          <Protected
            permission={permissions.post.read}
            data={ownPost}
            fallback={<span>locked</span>}
          >
            <span>read</span>
          </Protected>
        </Suspense>
      </PermDockProvider>,
    );
    const html = await new Response(prelude).text();
    expect(html).toContain('locked');
  });

  it('adopts each snapshotPromise once', async () => {
    const snapshot = await memberSnapshot();
    const store = createClientStore({ snapshot: emptySnapshot() });
    const first = Promise.resolve(snapshot);
    store.adopt(snapshot, first);
    const dock = store.get();
    expect(dock.can(permissions.post.update, ownPost)).toBe(true);
    store.adopt(emptySnapshot(), first);
    expect(store.get()).toBe(dock);
    store.adopt(emptySnapshot(), Promise.resolve(emptySnapshot()));
    expect(store.get().can(permissions.post.update, ownPost)).toBe(false);
  });

  it('builds the approval resume header', () => {
    expect(approvalHeaders('pd1.abc')).toEqual({
      'PermDock-Approval': 'pd1.abc',
    });
  });
});
