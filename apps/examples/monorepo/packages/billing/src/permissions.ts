import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Invoice = z.object({
  id: z.string(),
  customerId: z.string(),
});

export const billingPermissions = definePermissions({
  billing: {
    invoice: resource(Invoice, {
      id: 'id',
      actions: ['read', 'pay'],
    }),
    plan: resource({ collection: ['view', 'change'] }),
  },
});
