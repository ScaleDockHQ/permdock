import { z } from 'zod';

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
  subject,
} from '../index.ts';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'publish'],
    collection: ['create', 'list'],
  }),
});

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

const member = role('member', [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { where: { authorId: subject.id } }),
  allow(permissions.post.delete, {
    where: { authorId: subject.id },
    approval: 'human',
  }),
]);

const admin = role('admin', [
  ...member.grants,
  allow(permissions.post.update),
  allow(permissions.post.delete),
  allow(permissions.post.publish),
  deny(permissions.post.publish, { where: { published: true } }),
]);

export const policy = definePolicy(permissions, {
  roles: [member, admin],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: 'boundary',
});

export const ownPost = {
  id: 'p1',
  authorId: 'u1',
  orgId: 'o1',
  published: false,
};

export const otherPost = {
  id: 'p2',
  authorId: 'u9',
  orgId: 'o1',
  published: true,
};

export const memberUser: User = { id: 'u1', orgId: 'o1', roles: ['member'] };
export const adminUser: User = { id: 'u2', orgId: 'o1', roles: ['admin'] };
