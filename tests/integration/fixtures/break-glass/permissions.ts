import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Patient = z.object({
  id: z.string(),
  restricted: z.boolean(),
});

export const permissions = definePermissions({
  patient: resource(Patient, { actions: ['read'] }),
});
