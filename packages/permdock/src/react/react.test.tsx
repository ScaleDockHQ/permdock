import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createPermDock } from '../core/permdock.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { approvalHeaders } from './headers.ts';
import {
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from './hooks.ts';
import { Protected } from './protected.tsx';
import { PermDockProvider } from './provider.tsx';
import { createClientStore } from './store.ts';

async function memberSnapshot() {
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
  return `${allowed}:${actions.granted.length}:${editable.length}:${editable.partial}:${tenant.tenant ?? 'none'}:${memberships.length}:${roles.join(',')}:${subject.simulated}:${dock.status()}`;
}

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
                portable: false as const,
              }
            : grant,
        ),
      },
      endpoint: '/api/permdock',
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

  it('builds the approval resume header', () => {
    expect(approvalHeaders('pd1.abc')).toEqual({
      'PermDock-Approval': 'pd1.abc',
    });
  });
});
