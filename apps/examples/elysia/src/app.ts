import type { Policy } from 'permdock';

import { Elysia } from 'elysia';
import { createPermDock } from 'permdock/elysia';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const { permdock, protect } = createPermDock(policy as Policy, {
  subject: () => memberUser,
});

export const app = new Elysia()
  .use(permdock())
  .get('/health', () => ({ ok: true }))
  .patch('/posts/:id', () => ({ ok: true }), {
    beforeHandle: protect(permissions.post.update, () => ownPost),
  })
  .post('/posts/:id/publish', () => ({ ok: true }), {
    beforeHandle: protect(permissions.post.publish, () => ownPost),
  });
