import type { Policy } from 'permdock';

import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { toWhere } from 'permdock/prisma';

import { permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  const dock = await createPermDock(policy as Policy, memberUser);
  const where = toWhere(dock.where(permissions.post.list));
  return c.json({ where });
});

app.patch('/posts/:id', async (c) => {
  const dock = await createPermDock(policy as Policy, memberUser);
  const where = toWhere(dock.where(permissions.post.update));
  return c.json({ where });
});
