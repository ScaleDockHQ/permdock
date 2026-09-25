import {
  crud,
  definePermissions,
  definePlans,
  defineRoles,
  resource,
} from 'permdock';
import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  archived: z.boolean(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const permissions = definePermissions({
  project: resource(
    ProjectSchema,
    crud({ relations: { org: { field: 'orgId', memberOf: 'tenant' } } }),
  ),
  member: resource({ collection: ['list', 'invite', 'assignRole'] }),
  settings: resource({ collection: ['manage'] }),
  billing: resource({ collection: ['read', 'manage'] }),
  analytics: resource({ collection: ['read'] }),
  audit: resource({ collection: ['read'] }),
  sso: resource({ collection: ['manage'] }),
  apiKey: resource({ collection: ['manage'] }),
  integration: resource({ collection: ['read'] }),
});

export const roles = defineRoles({
  owner: { on: 'tenant', assignable: true },
  admin: { on: 'tenant', assignable: true },
  member: { on: 'tenant', assignable: true },
  viewer: { on: 'tenant', assignable: true },
});

export const plans = definePlans({ free: {}, pro: {} });

export const roleNames = ['owner', 'admin', 'member', 'viewer'] as const;
