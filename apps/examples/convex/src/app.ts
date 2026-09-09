import { Hono } from 'hono';
import { createPermDock } from 'permdock/convex';

import { permissions } from './permissions.ts';
import { policy } from './policy.ts';

function userOf(ctx: unknown): { readonly id: string } | null {
  if (ctx === null || typeof ctx !== 'object' || !('user' in ctx)) {
    return null;
  }
  const { user } = ctx;
  if (user === null || typeof user !== 'object' || !('id' in user)) {
    return null;
  }
  const { id } = user;
  return typeof id === 'string' ? { id } : null;
}

const { withPermDock, snapshotQuery } = createPermDock(policy, {
  subject: (ctx) => {
    const identity = userOf(ctx);
    return identity === null ? null : { id: identity.id, roles: ['member'] };
  },
});

const list = withPermDock((ctx) =>
  ctx.permdock.filter(permissions.post.read, [
    { id: 'p1', authorId: 'user-1' },
    { id: 'p2', authorId: 'user-2' },
  ]),
);

const snapshot = snapshotQuery() as {
  readonly handler: (
    ctx: { readonly user?: { readonly id: string } },
    args: Record<string, never>,
  ) => Promise<{ readonly grants: readonly unknown[] }>;
};

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  const rows = await list({ user: { id: 'user-1' } }, {});
  return c.json({ rows });
});

app.get('/snapshot', async (c) => {
  const body = await snapshot.handler({ user: { id: 'user-1' } }, {});
  return c.json({ grants: body.grants.length });
});
