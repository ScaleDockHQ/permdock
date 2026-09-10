import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { memoryApprovalStore, resolveApproval } from '../approvals/index.ts';
import { APPROVAL_HEADER } from '../approvals/types.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { Protected } from '../react/protected.tsx';
import { createPermDock } from './index.ts';

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

    const dock = await getPermDock();
    expect(() => dock.assert(permissions.post.publish, ownPost)).toThrow(
      /post.publish/,
    );
    expect(seen).toEqual(['denied']);
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
    const payload = (await json(snapshot)) as {
      readonly v: number;
      readonly grants: readonly { readonly permission: string }[];
    };
    expect(payload.v).toBe(3);
    expect(
      payload.grants.some((grant) => grant.permission === 'post.update'),
    ).toBe(true);

    const discovery = await GET(
      new Request('https://app.example/.well-known/authzen-configuration'),
    );
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
    const dock = await getPermDock();
    const required = dock.decide(permissions.post.delete, ownPost);
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

  it('serialises a snapshot through the server PermDockProvider', async () => {
    const { PermDockProvider } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const tree = await PermDockProvider({
      children: (
        <Protected
          permission={permissions.post.update}
          data={ownPost}
          fallback={<span>locked</span>}
        >
          <span>edit</span>
        </Protected>
      ),
    });
    expect(renderToStaticMarkup(tree)).toContain('edit');
  });
});
