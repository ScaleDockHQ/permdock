import { definePermissions, defineRoles, resource } from 'permdock';
import { z } from 'zod';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list', 'create'],
    relations: { author: 'authorId' },
  }),
});

export const roles = defineRoles({
  member: {},
});
