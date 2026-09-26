import { describe, expect, it } from 'vitest';

import { memoryApprovalStore } from '../approvals/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import * as saas from '../fixtures/saas.ts';
import { allow, anyone, createPermDock, definePolicy, deny } from '../index.ts';
import { createAgentKernel, idOf, mayUse, resourceRef } from './kernel.ts';

function tools() {
  return {
    delete_post: {
      permission: permissions.post.delete,
      data: (args: unknown) => {
        const id = (args as { readonly id?: string }).id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
    list_posts: { permission: permissions.post.list },
    publish_post: {
      permission: permissions.post.publish,
      data: (args: unknown) => {
        const id = (args as { readonly id?: string }).id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
    missing_row: {
      permission: permissions.post.update,
      data: () => null,
    },
    explode: {
      permission: permissions.post.update,
      data: () => {
        throw new Error('loader failed');
      },
    },
  };
}

describe('agent kernel helpers', () => {
  it('reads a resource id from objects and ignores other values', () => {
    expect(idOf({ id: 'p1' })).toBe('p1');
    expect(idOf({ id: 7 })).toBe('7');
    expect(idOf({ id: true })).toBeUndefined();
    expect(idOf(null)).toBeUndefined();
    expect(idOf('p1')).toBeUndefined();
    expect(resourceRef(permissions.post.update, ownPost)).toEqual({
      type: 'post',
      id: 'p1',
    });
    expect(resourceRef(permissions.post.list, undefined)).toEqual({
      type: 'post',
    });
  });
});

describe('createAgentKernel', () => {
  it('maps granted, denied and unmapped tools', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: (ctx: { readonly user: typeof memberUser }) => ctx.user,
      tools: tools(),
    });
    const ctx = { user: memberUser };

    const granted = await kernel.decideTool('list_posts', {}, ctx);
    expect(granted.outcome).toBe('granted');

    const denied = await kernel.decideTool('publish_post', { id: 'p1' }, ctx);
    expect(denied.outcome).toBe('denied');
    if (denied.outcome === 'denied') {
      expect(denied.reason).toContain('post.publish');
    }

    const unmapped = await kernel.decideTool('unknown', {}, ctx);
    expect(unmapped).toMatchObject({
      outcome: 'denied',
      permission: undefined,
      reason: 'Denied: unmapped tool unknown.',
    });
  });

  it('denies when a data loader returns nothing or throws', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      tools: tools(),
    });

    const missing = await kernel.decideTool('missing_row', {}, {});
    expect(missing.outcome).toBe('denied');
    if (missing.outcome === 'denied') {
      expect(missing.decision?.denials[0]?.reason).toBe('validation');
    }

    const thrown = await kernel.decideTool('explode', {}, {});
    expect(thrown).toMatchObject({
      outcome: 'denied',
      reason: 'Denied: explode failed closed.',
    });
  });

  it('treats a thrown subject as anonymous and a thrown actor as absent', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => {
        throw new Error('session failed');
      },
      actor: () => {
        throw new Error('actor failed');
      },
      tenant: () => {
        throw new Error('tenant failed');
      },
      tools: tools(),
    });
    const dock = await kernel.instance({});
    expect(dock.subject.principal).toBeNull();
    expect(dock.subject.actor).toBeUndefined();
    expect(mayUse(dock, permissions.post.list)).toBe(false);

    const denied = await kernel.decideTool('list_posts', {}, {});
    expect(denied.outcome).toBe('denied');
  });

  it('accepts a static tenant and a valid actor', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      actor: () => ({ id: 'agent-1', kind: 'test' }),
      tenant: 'acme',
      tools: tools(),
    });
    const dock = await kernel.instance({});
    expect(dock.subject.actor).toEqual({ id: 'agent-1', kind: 'test' });
  });

  it('lists tools that have any matching grant', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: (ctx: { readonly user: typeof memberUser }) => ctx.user,
      tools: tools(),
    });
    const memberTools = await kernel.allowedToolNames({ user: memberUser });
    expect(memberTools.has('list_posts')).toBe(true);
    expect(memberTools.has('delete_post')).toBe(true);
    expect(memberTools.has('publish_post')).toBe(false);

    const adminTools = await kernel.allowedToolNames({ user: adminUser });
    expect(adminTools.has('publish_post')).toBe(true);
  });

  it('shares one instance between concurrent calls on a context', async () => {
    let reads = 0;
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => {
        reads += 1;
        return memberUser;
      },
      tools: tools(),
    });
    const ctx = { id: 'same' };
    const [a, b] = await Promise.all([
      kernel.instance(ctx),
      kernel.instance(ctx),
    ]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
  });

  it('re-reads the subject on a later call, so a revoked role takes effect', async () => {
    let user: typeof memberUser = adminUser;
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => user,
      tools: tools(),
    });
    const ctx = { session: 's1' };
    expect(
      (await kernel.decideTool('publish_post', { id: 'p1' }, ctx)).outcome,
    ).toBe('granted');
    user = memberUser;
    expect(
      (await kernel.decideTool('publish_post', { id: 'p1' }, ctx)).outcome,
    ).toBe('denied');
    expect((await kernel.allowedToolNames(ctx)).has('publish_post')).toBe(
      false,
    );
  });

  it('lists tools per active tenant membership, not every membership', async () => {
    const kernel = createAgentKernel(saas.policy, {
      adapter: 'test',
      subject: () => saas.alice,
      tenant: (ctx: { readonly tenant: string }) => ctx.tenant,
      tools: {
        delete_project: { permission: saas.permissions.project.delete },
        read_project: { permission: saas.permissions.project.read },
        manage_billing: { permission: saas.permissions.billing.manage },
      },
    });
    const acme = await kernel.allowedToolNames({ tenant: 'acme' });
    expect([...acme].toSorted()).toEqual(['delete_project', 'read_project']);
    const globex = await kernel.allowedToolNames({ tenant: 'globex' });
    expect([...globex]).toEqual(['read_project']);
    const none = await kernel.allowedToolNames({ tenant: 'initech' });
    expect([...none]).toEqual([]);
  });

  it('lists tools granted to anyone and hides unconditionally denied ones', async () => {
    const open = definePolicy(permissions, {
      roles: [],
      grants: [
        allow(permissions.post.read, { to: anyone() }),
        allow(permissions.post.list, { to: anyone() }),
        deny(permissions.post.list, { to: anyone() }),
      ],
      subject: (user: typeof memberUser | null) => user,
    });
    const kernel = createAgentKernel(open, {
      adapter: 'test',
      subject: () => null,
      tools: {
        read_post: { permission: permissions.post.read },
        list_posts: { permission: permissions.post.list },
      },
    });
    expect([...(await kernel.allowedToolNames({}))]).toEqual(['read_post']);
  });

  it('hides tools outside the delegated scopes', async () => {
    const delegated = await createPermDock(policy, memberUser, {
      delegation: { scopes: ['post:list'] },
    });
    expect(mayUse(delegated, permissions.post.list)).toBe(true);
    expect(mayUse(delegated, permissions.post.delete)).toBe(false);
  });

  it('resumes a stored approval from the recomputed token, once', async () => {
    const store = memoryApprovalStore();
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      store,
      tools: tools(),
    });
    const asked = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    if (asked.outcome !== 'approval-required') {
      throw new Error('expected approval-required');
    }
    expect(
      (await kernel.decideTool('delete_post', { id: 'p1' }, {})).outcome,
    ).toBe('approval-required');
    await store.resolve(asked.token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });
    expect(
      (await kernel.decideTool('delete_post', { id: 'p2' }, {})).outcome,
    ).toBe('denied');
    expect(
      (await kernel.decideTool('delete_post', { id: 'p1' }, {})).outcome,
    ).toBe('granted');
    const again = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    expect(again.outcome).toBe('denied');
    if (again.outcome === 'denied') {
      expect(again.decision?.denials[0]?.detail).toBe('approval-consumed');
    }
  });

  it('reports a rejected approval instead of asking again', async () => {
    const store = memoryApprovalStore();
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      store,
      tools: tools(),
    });
    const asked = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    if (asked.outcome !== 'approval-required') {
      throw new Error('expected approval-required');
    }
    await store.resolve(asked.token, {
      status: 'rejected',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });
    const rejected = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    expect(rejected.outcome).toBe('denied');
    if (rejected.outcome === 'denied') {
      expect(rejected.decision?.denials[0]?.detail).toBe('approval-rejected');
    }
  });

  it('parks approval-required tools and grants on a matching resume', async () => {
    const store = memoryApprovalStore();
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      store,
      tools: tools(),
    });

    const asked = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    expect(asked.outcome).toBe('approval-required');
    if (asked.outcome !== 'approval-required') {
      return;
    }
    expect(await store.get(asked.token)).not.toBeNull();

    const pending = await kernel.decideTool(
      'delete_post',
      { id: 'p1' },
      {},
      {
        resumeToken: asked.token,
      },
    );
    expect(pending.outcome).toBe('denied');
    if (pending.outcome === 'denied') {
      expect(pending.decision?.denials[0]?.detail).toBe('approval-pending');
    }

    await store.resolve(asked.token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });

    const resumed = await kernel.decideTool(
      'delete_post',
      { id: 'p1' },
      {},
      { resumeToken: asked.token },
    );
    expect(resumed.outcome).toBe('granted');

    const replayed = await kernel.decideTool(
      'delete_post',
      { id: 'p1' },
      {},
      { resumeToken: asked.token },
    );
    expect(replayed.outcome).toBe('denied');
    if (replayed.outcome === 'denied') {
      expect(replayed.decision?.denials[0]?.detail).toBe('approval-consumed');
    }

    const foreign = await kernel.decideTool(
      'delete_post',
      { id: 'p1' },
      {},
      { resumeToken: 'not-a-token' },
    );
    expect(foreign.outcome).toBe('approval-required');
  });

  it('denies a resume when no store is configured', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => memberUser,
      tools: tools(),
    });
    const asked = await kernel.decideTool('delete_post', { id: 'p1' }, {});
    expect(asked.outcome).toBe('approval-required');
    if (asked.outcome !== 'approval-required') {
      return;
    }
    const resumed = await kernel.decideTool(
      'delete_post',
      { id: 'p1' },
      {},
      { resumeToken: asked.token },
    );
    expect(resumed.outcome).toBe('denied');
    if (resumed.outcome === 'denied') {
      expect(resumed.decision?.denials[0]?.detail).toBe('approval-not-found');
    }
  });
});
