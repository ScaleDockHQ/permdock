import type { Policy } from 'permdock';

import { Hono } from 'hono';
import { createPermDock } from 'permdock/hono';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const { protect } = createPermDock(policy as Policy, {
  subject: () => memberUser,
});

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.patch(
  '/posts/:id',
  protect(permissions.post.update, () => ownPost),
  (c) => c.json({ ok: true }),
);

app.post(
  '/posts/:id/publish',
  protect(permissions.post.publish, () => ownPost),
  (c) => c.json({ ok: true }),
);
