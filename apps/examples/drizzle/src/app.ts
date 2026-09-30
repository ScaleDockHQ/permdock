import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { toWhere } from 'permdock/drizzle';

import { db, ready } from './db.ts';
import { permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';
import { posts } from './schema.ts';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  await ready;
  const dock = await createPermDock(policy, memberUser);
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(toWhere(dock.where(permissions.post.list), posts))
    .orderBy(posts.id);
  return c.json({ ok: true, posts: rows.map((row) => row.id) });
});

app.patch('/posts/:id', async (c) => {
  await ready;
  const dock = await createPermDock(policy, memberUser);
  const updated = await db
    .update(posts)
    .set({ title: 'Edited' })
    .where(
      and(
        eq(posts.id, c.req.param('id')),
        toWhere(dock.where(permissions.post.update), posts),
      ),
    )
    .returning({ id: posts.id });
  if (updated.length === 0) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true, id: updated[0]?.id });
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
