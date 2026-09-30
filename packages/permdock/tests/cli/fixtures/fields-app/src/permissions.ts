import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Invoice = z.object({
  id: z.string(),
  orgId: z.string(),
  authorId: z.string(),
  title: z.string(),
  amount: z.number().int(),
  note: z.string(),
});

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    actions: ['read', 'update'],
    collection: ['list', 'create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});
