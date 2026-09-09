import type { Policy } from 'permdock';

import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { toWhere } from 'permdock/drizzle';

import { permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';
import { posts } from './schema.ts';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  const dock = await createPermDock(policy as Policy, memberUser);
  const filter = toWhere(
    dock.where(permissions.post.list),
    posts as unknown as Record<string, unknown>,
  );
  return c.json({ ok: filter !== null });
});

app.patch('/posts/:id', async (c) => {
  const dock = await createPermDock(policy as Policy, memberUser);
  const filter = toWhere(
    dock.where(permissions.post.update),
    posts as unknown as Record<string, unknown>,
  );
  return c.json({ ok: filter !== null });
});
