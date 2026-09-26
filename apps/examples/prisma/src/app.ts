import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { toWhere } from 'permdock/prisma';

import type { Prisma } from './generated/client.ts';

import { db, requiredFields } from './db.ts';
import { permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/posts', async (c) => {
  const prisma = await db;
  const dock = await createPermDock(policy, memberUser);
  const rows = await prisma.post.findMany({
    where: toWhere<Prisma.postWhereInput>(dock.where(permissions.post.list), {
      requiredFields,
    }),
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return c.json({ ok: true, posts: rows.map((row) => row.id) });
});

app.patch('/posts/:id', async (c) => {
  const prisma = await db;
  const dock = await createPermDock(policy, memberUser);
  const { count } = await prisma.post.updateMany({
    where: {
      AND: [
        { id: c.req.param('id') },
        toWhere<Prisma.postWhereInput>(dock.where(permissions.post.update), {
          requiredFields,
        }),
      ],
    },
    data: { title: 'Edited' },
  });
  if (count === 0) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true, id: c.req.param('id') });
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
