import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Project = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
});

export const Task = z.object({
  id: z.string(),
  orgId: z.string(),
  authorId: z.string(),
  locked: z.boolean(),
});

export const Board = z.object({
  id: z.string(),
  orgId: z.string(),
  teamId: z.string(),
});

export const permissions = definePermissions({
  project: resource(Project, {
    actions: ['read', 'update', 'delete'],
    collection: ['list', 'create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  task: resource(Task, {
    actions: ['read', 'update', 'delete'],
    collection: ['list', 'create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  board: resource(Board, {
    actions: ['read', 'update'],
    relations: {
      org: { field: 'orgId', memberOf: 'tenant' },
      team: { field: 'teamId', memberOf: 'team' },
    },
  }),
});
