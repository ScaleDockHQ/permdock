import {
  crud,
  definePermissions,
  definePlans,
  defineRoles,
  resource,
} from 'permdock';

import { rowSchema } from './schema.ts';

export const SaasProjectSchema = rowSchema({
  id: 'string',
  orgId: 'string',
  ownerId: 'string',
  name: 'string',
  archived: 'boolean',
});

export const SaasDocSchema = rowSchema({
  id: 'string',
  orgId: 'string',
  teamId: 'nullable-string',
  title: 'string',
  locked: 'boolean',
});

export type SaasProject = {
  readonly id: string;
  readonly orgId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly archived: boolean;
};

export type SaasDoc = {
  readonly id: string;
  readonly orgId: string;
  readonly teamId: string | null;
  readonly title: string;
  readonly locked: boolean;
};

export const saasPermissions = definePermissions({
  project: resource(
    SaasProjectSchema,
    crud({ relations: { org: { field: 'orgId', memberOf: 'tenant' } } }),
  ),
  doc: resource(
    SaasDocSchema,
    crud({
      relations: {
        org: { field: 'orgId', memberOf: 'tenant' },
        team: { field: 'teamId', memberOf: 'team' },
      },
    }),
  ),
  member: resource({ collection: ['list', 'invite', 'assignRole'] }),
  settings: resource({ collection: ['manage'] }),
  billing: resource({ collection: ['read', 'manage'] }),
  analytics: resource({ collection: ['read'] }),
  audit: resource({ collection: ['read'] }),
  sso: resource({ collection: ['manage'] }),
  apiKey: resource({ collection: ['manage', 'create', 'revokeAll'] }),
  integration: resource({ collection: ['read'] }),
});

export const saasRoles = defineRoles({
  owner: { on: 'tenant', assignable: true },
  admin: { on: 'tenant', assignable: true },
  member: { on: 'tenant', assignable: true },
  viewer: { on: 'tenant', assignable: true },
  lead: { on: 'team', assignable: true },
  /** Resource-scoped; `role(..., { on: saasPermissions.project })` in the policy. */
  collaborator: { assignable: true },
});

export const saasPlans = definePlans({ free: {}, pro: {} });

export const saasTenantRoleNames = [
  'owner',
  'admin',
  'member',
  'viewer',
] as const;
