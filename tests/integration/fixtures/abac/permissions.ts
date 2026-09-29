import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Report = z.object({
  id: z.string(),
  region: z.string(),
  clearance: z.number().int(),
});

export const Ticket = z.object({ id: z.string(), region: z.string() });

export const permissions = definePermissions({
  report: resource(Report, { actions: ['read'] }),
  ticket: resource(Ticket, { actions: ['read', 'update'] }),
  record: resource(Ticket, { actions: ['read', 'delete'] }),
});
