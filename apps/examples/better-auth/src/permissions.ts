import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  organizationId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    collection: ['create', 'list'],
    relations: { org: { field: 'organizationId', memberOf: 'tenant' } },
  }),
});

export const ownPost = {
  id: 'p1',
  authorId: 'user-1',
  organizationId: 'o_acme',
};
