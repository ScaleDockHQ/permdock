import { z } from 'zod';

import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from '../../src/index.ts';

/** Every grant shape the Postgres RLS mapping table lists, on one table. */
const Post = z.object({
  id: z.string(),
  orgId: z.string(),
  authorId: z.string(),
  published: z.boolean(),
  locked: z.boolean(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    collection: ['create', 'list'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});

const { post } = permissions;

export const policy = definePolicy(permissions, {
  subject: () => null,
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('staff', [allow(post.read)]),
    role('admin', [allow([post.read, post.update, post.delete])], {
      on: 'tenant',
    }),
    role(
      'member',
      [
        allow(post.read),
        allow(post.create, { check: { authorId: principal.id } }),
        allow(post.update, {
          where: { authorId: principal.id },
          check: { authorId: principal.id },
        }),
        deny(post.delete, { where: { locked: true } }),
      ],
      { on: 'tenant' },
    ),
  ],
  grants: [allow(post.read, { to: anyone(), where: { published: true } })],
});
