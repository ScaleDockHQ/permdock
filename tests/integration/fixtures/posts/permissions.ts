import { definePermissions, defineRoles, resource } from 'permdock';
import { z } from 'zod';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

export const Job = z.object({
  id: z.string(),
  scope: z.string(),
  teamId: z.string().nullable(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list', 'create'],
    relations: { author: 'authorId' },
  }),
  job: resource(Job, {
    id: 'id',
    actions: ['read'],
    collection: ['list'],
  }),
});

export const roles = defineRoles({
  member: {},
});
