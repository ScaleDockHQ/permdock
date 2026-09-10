import { definePermissions, defineRoles, resource } from 'permdock';
import { z } from 'zod';

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
    relations: { author: 'authorId' },
  }),
});

export const roles = defineRoles({
  member: {},
  admin: {},
});

export const ownPost = {
  id: 'p1',
  authorId: 'u1',
  orgId: 'o1',
  published: false,
};
