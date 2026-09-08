import { describe, expect, it } from 'vitest';

import { memoryApprovalStore, resolveApproval } from '../approvals/index.ts';
import { APPROVAL_HEADER } from '../approvals/types.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

function request(
  path = 'https://api.example/posts/p1',
  init?: RequestInit,
): Request {
  return new Request(path, init);
}

describe('permdock/server', () => {
  it('memoises one instance per Request and isolates factories', async () => {
    let reads = 0;
    const { permdock } = createPermDock(policy, {
      subject: () => {
        reads += 1;
        return memberUser;
      },
    });
    const req = request();
    const [a, b] = await Promise.all([permdock(req), permdock(req)]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
    expect(a.can(permissions.post.update, ownPost)).toBe(true);

    const other = createPermDock(policy, { subject: () => null });
    const anon = await other.permdock(request());
    expect(anon.can(permissions.post.update, ownPost)).toBe(false);
  });

  it('treats a thrown subject resolver as anonymous', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => {
        throw new Error('session failed');
      },
    });
    const dock = await permdock(request());
    expect(dock.subject.principal).toBeNull();
    expect(dock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it('protects a granted instance action and 404s a missing row', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const granted = await protect(
      permissions.post.update,
      () => ownPost,
    )(request());
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.decision.outcome).toBe('granted');
      expect(granted.data).toEqual(ownPost);
    }

    const missing = await protect(
      permissions.post.update,
      () => null,
    )(request());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(404);
    }
  });

  it('returns Problem Details with WWW-Authenticate on a deny', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const denied = await protect(
      permissions.post.update,
      () => otherPost,
    )(request());
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(403);
    expect(denied.response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    const body = (await denied.response.json()) as {
      readonly permission: string;
      readonly denials: readonly unknown[];
    };
    expect(body.permission).toBe('post.update');
    expect(body.denials.length).toBeGreaterThan(0);
  });

  it('answers 401 invalid_token for an anonymous caller', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const denied = await protect(
      permissions.post.read,
      () => ownPost,
    )(request());
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers.get('WWW-Authenticate')).toContain(
      'invalid_token',
    );
  });

  it('resumes an approved PermDock-Approval header on protect', async () => {
    const store = memoryApprovalStore();
    const { permdock, protect } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const dock = await permdock(request());
    const required = dock.decide(permissions.post.delete, ownPost);
    expect(required.outcome).toBe('approval-required');
    if (required.outcome !== 'approval-required') {
      return;
    }

    const pending = await protect(
      permissions.post.delete,
      () => ownPost,
    )(request());
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.response.status).toBe(403);
      const body = (await pending.response.json()) as {
        readonly token?: string;
      };
      expect(body.token).toBe(required.token);
    }

    await resolveApproval(store, required.token, {
      status: 'approved',
      by: { principal: { id: 'u9', roles: ['admin'] }, context: {} },
    });

    const resumed = await protect(
      permissions.post.delete,
      () => ownPost,
    )(
      request('https://api.example/posts/p1', {
        headers: { [APPROVAL_HEADER]: required.token },
      }),
    );
    expect(resumed.ok).toBe(true);
  });

  it('exposes AuthZEN evaluations and OpenAPI security hooks', async () => {
    const { handler, openapi } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const { POST } = handler();
    const response = await POST(
      new Request('https://api.example/access/v1/evaluations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', properties: ownPost },
              action: { name: 'update' },
            },
          ],
        }),
      }),
    );
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);

    const security = openapi.security(permissions.post.delete);
    expect(security.security[0]?.oauth2).toEqual(['post:delete']);
    expect(security['x-permdock-permissions']).toEqual(['post.delete']);
    expect(openapi.securitySchemes().oauth2).toBeDefined();
  });
});
