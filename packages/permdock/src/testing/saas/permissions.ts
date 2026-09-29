import type { StandardSchemaV1 } from '@standard-schema/spec';

import type {
  InferPermissionTree,
  ResourceInit,
} from '../../core/permissions.ts';
import type { Plan, Role } from '../../core/vocabulary.ts';

import {
  crud,
  definePermissions,
  definePlans,
  defineRoles,
  resource,
} from '../../index.ts';
import { rowSchema } from './schema.ts';

export const SaasProjectSchema: StandardSchemaV1<SaasProject> = rowSchema({
  id: 'string',
  orgId: 'string',
  ownerId: 'string',
  name: 'string',
  archived: 'boolean',
});

export const SaasDocSchema: StandardSchemaV1<SaasDoc> = rowSchema({
  id: 'string',
  orgId: 'string',
  teamId: 'nullable-string',
  title: 'string',
  locked: 'boolean',
});

export const SaasFolderSchema: StandardSchemaV1<SaasFolder> = rowSchema({
  id: 'string',
  orgId: 'string',
  parentId: 'nullable-string',
  name: 'string',
  restricted: 'boolean',
});

/** A folder in an org's tree; `restricted` keeps grants held on its ancestors out. */
export type SaasFolder = {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly restricted: boolean;
};

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

type CrudActions = readonly ['read', 'update', 'delete'];
type CrudCollection = readonly ['create', 'list'];
type Collection<C extends readonly string[]> = ResourceInit<
  unknown,
  readonly [],
  C
>;

type SaasDefinition = {
  readonly project: ResourceInit<SaasProject, CrudActions, CrudCollection>;
  readonly doc: ResourceInit<SaasDoc, CrudActions, CrudCollection>;
  readonly folder: ResourceInit<SaasFolder, CrudActions, CrudCollection>;
  readonly member: Collection<readonly ['list', 'invite', 'assignRole']>;
  readonly settings: Collection<readonly ['manage']>;
  readonly billing: Collection<readonly ['read', 'manage']>;
  readonly analytics: Collection<readonly ['read']>;
  readonly audit: Collection<readonly ['read']>;
  readonly sso: Collection<readonly ['manage']>;
  readonly apiKey: Collection<readonly ['manage', 'create', 'revokeAll']>;
  readonly integration: Collection<readonly ['read']>;
};

export const saasPermissions: InferPermissionTree<SaasDefinition> =
  definePermissions({
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
    folder: resource(
      SaasFolderSchema,
      crud({
        parent: { field: 'parentId', resource: 'folder' },
        restricted: 'restricted',
        relations: {
          org: { field: 'orgId', memberOf: 'tenant' },
          viewer: {
            edge: 'folder_share',
            object: 'folder_id',
            expiresAt: 'expires_at',
          },
          editor: { edge: 'folder_editor', object: 'folder_id' },
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

type SaasRoleName =
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer'
  | 'lead'
  | 'collaborator';

export const saasRoles: { readonly [K in SaasRoleName]: Role<K> } = defineRoles(
  {
    owner: { on: 'tenant', assignable: true },
    admin: { on: 'tenant', assignable: true },
    member: { on: 'tenant', assignable: true },
    viewer: { on: 'tenant', assignable: true },
    lead: { on: 'team', assignable: true },
    /** Resource-scoped; `role(..., { on: saasPermissions.project })` in the policy. */
    collaborator: { assignable: true },
  },
);

export const saasPlans: { readonly [K in 'free' | 'pro']: Plan<K> } =
  definePlans({ free: {}, pro: {} });

export const saasTenantRoleNames = [
  'owner',
  'admin',
  'member',
  'viewer',
] as const;
