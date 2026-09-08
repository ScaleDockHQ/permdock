import type { Policy } from 'permdock';

import Fastify from 'fastify';
import { createPermDock } from 'permdock/fastify';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const { permdock, protect } = createPermDock(policy as Policy, {
  subject: () => memberUser,
});

export const app = Fastify();

await app.register(permdock);

app.get('/health', () => ({ ok: true }));

app.patch(
  '/posts/:id',
  {
    preHandler: protect(permissions.post.update, () => ownPost),
  },
  () => ({ ok: true }),
);

app.post(
  '/posts/:id/publish',
  {
    preHandler: protect(permissions.post.publish, () => ownPost),
  },
  () => ({ ok: true }),
);
