import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { toWhere } from 'permdock/drizzle';

import { permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';
import { posts } from './schema.ts';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  const dock = await createPermDock(policy, memberUser);
  const filter = toWhere(
    dock.where(permissions.post.list),
    posts as unknown as Record<string, unknown>,
  );
  return c.json({ ok: filter !== null });
});

app.patch('/posts/:id', async (c) => {
  const dock = await createPermDock(policy, memberUser);
  const filter = toWhere(
    dock.where(permissions.post.update),
    posts as unknown as Record<string, unknown>,
  );
  return c.json({ ok: filter !== null });
});

app.post('/posts/:id/publish', async (c) => {
  const dock = await createPermDock(policy, memberUser);
  const post = {
    id: c.req.param('id'),
    authorId: memberUser.id,
    orgId: memberUser.orgId,
    published: false,
  };
  if (!dock.can(permissions.post.publish, post)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true });
});
