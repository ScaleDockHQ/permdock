import { describe, expect, it, vi } from 'vitest';

import type { PermDock } from '../../src/core/permdock.ts';
import type { PdpFactory, PdpPermDock } from '../../src/pdp/types.ts';

import { createPermDock as createCoreDock } from '../../src/core/permdock.ts';
import { createKernel, tenantScope } from '../../src/server/create.ts';
import { createPermDock } from '../../src/server/index.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const request = (): Request => new Request('https://api.example/posts/p1');

describe('tenantScope', () => {
  it('passes a string through and treats a throwing resolver as no tenant', async () => {
    expect(await tenantScope('o1', null)).toEqual({ tenant: 'o1' });
    expect(await tenantScope(undefined, null)).toEqual({ tenant: undefined });
    expect(await tenantScope(() => 'o2', null)).toEqual({ tenant: 'o2' });
    expect(
      await tenantScope(() => {
        throw new Error('no tenant');
      }, null),
    ).toEqual({ tenant: undefined });
  });
});

describe('actor resolution', () => {
  it.each<[string, () => unknown, unknown]>([
    [
      'a well-formed actor',
      () => ({ id: 'agent-1', kind: 'agent' }),
      { id: 'agent-1', kind: 'agent' },
    ],
    ['a malformed actor', () => ({ id: 1, kind: 'agent' }), undefined],
    ['an array', () => [], undefined],
    [
      'a throwing resolver',
      () => {
        throw new Error('bad header');
      },
      undefined,
    ],
  ])('keeps %s only when it is an Actor', async (_label, actor, expected) => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      actor,
    });
    const dock = await permdock(request());
    expect(dock.subject.actor).toEqual(expected);
  });
});

describe('createKernel', () => {
  it('resolves the subject once per request and wraps every instance', async () => {
    const subject = vi.fn<() => typeof memberUser>(() => memberUser);
    const wrapped: PermDock[] = [];
    const kernel = createKernel(policy, {
      subject,
      wrap: (dock) => {
        wrapped.push(dock);
        return dock;
      },
    });
    const shared = request();
    const first = await kernel.permdock(shared);
    expect(await kernel.permdock(shared)).toBe(first);
    await kernel.permdock(shared, { tenant: 'o1' });
    expect({
      calls: subject.mock.calls.length,
      wrapped: wrapped.length,
    }).toEqual({
      calls: 1,
      wrapped: 2,
    });
  });

  it('serves the evaluations handler through a tenant scope', async () => {
    const scope = vi.fn<(request: Request) => { readonly tenant: string }>(
      () => ({
        tenant: 'o1',
      }),
    );
    const kernel = createKernel(policy, { subject: () => memberUser });
    const response = await kernel.handler(scope).POST(
      new Request('https://api.example/access/v1/evaluations', {
        method: 'POST',
        body: JSON.stringify({
          evaluations: [{ action: { name: 'post.list' } }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it('answers problem() without a permission with a generic 403', async () => {
    const { problem } = createPermDock(policy, { subject: () => memberUser });
    const dock = await createCoreDock(policy, memberUser);
    const response = problem(dock.decide(permissions.post.publish, ownPost));
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 403,
      body: { title: 'Permission denied', detail: 'denied' },
    });
  });

  it('rethrows a build failure that is not a signature rejection', async () => {
    const pdp: PdpFactory = () => Promise.reject(new Error('pdp config'));
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      pdp,
    });
    await expect(protect(permissions.post.list)(request())).rejects.toThrow(
      'pdp config',
    );
  });

  it('denies with pdp-unavailable when the remote decision rejects', async () => {
    const pdp: PdpFactory = async (p, user, options) => {
      const dock = await createCoreDock(p, user, options);
      // SAFETY: the kernel only calls decide on the remote instance in protect.
      return {
        ...dock,
        decide: () => Promise.reject(new Error('pdp down')),
      } as unknown as PdpPermDock;
    };
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      pdp,
    });
    const guard = await protect(permissions.post.read, () => ({
      ...ownPost,
      id: 7,
    }))(request());
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
    }
  });
});
