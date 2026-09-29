import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    collection: ['create', 'list'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});

export const ownPost = {
  id: 'p1',
  authorId: 'user_1',
  orgId: 'org_1',
};
