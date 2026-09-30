import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Service = z.object({
  id: z.string(),
  env: z.string(),
});

export const permissions = definePermissions({
  deploy: resource(Service, {
    id: 'id',
    actions: { run: {}, rollback: { destructive: true } },
    collection: ['read'],
  }),
});

export const staging = { id: 'api', env: 'staging' };
export const production = { id: 'api', env: 'production' };
