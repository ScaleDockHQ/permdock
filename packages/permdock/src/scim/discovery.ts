import { GROUP_SCHEMA, ROLES_EXTENSION, USER_SCHEMA } from './types.ts';

const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    pagination: { cursor: true, index: true },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description:
          'Static bearer or RFC 7523 JWT bearer bound to the tenant.',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750.html',
        primary: true,
      },
    ],
  };
}

export function resourceTypes(): readonly Record<string, unknown>[] {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      schemaExtensions: [],
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      schemaExtensions: [{ schema: ROLES_EXTENSION, required: false }],
    },
  ];
}

type AttributeOptions = {
  readonly multiValued?: boolean;
  readonly required?: boolean;
  readonly uniqueness?: 'none' | 'server' | 'global';
  readonly subAttributes?: readonly Record<string, unknown>[];
};

// RFC 7643 section 7: every attribute definition carries `multiValued`.
function attribute(
  name: string,
  type: 'string' | 'boolean' | 'complex',
  options: AttributeOptions = {},
): Record<string, unknown> {
  return {
    name,
    type,
    multiValued: options.multiValued ?? false,
    required: options.required ?? false,
    ...(options.uniqueness === undefined
      ? {}
      : { uniqueness: options.uniqueness }),
    ...(options.subAttributes === undefined
      ? {}
      : { subAttributes: options.subAttributes }),
  };
}

export function schemas(): readonly Record<string, unknown>[] {
  return [
    {
      schemas: [SCHEMA_SCHEMA],
      id: USER_SCHEMA,
      name: 'User',
      attributes: [
        attribute('userName', 'string', {
          required: true,
          uniqueness: 'server',
        }),
        attribute('externalId', 'string', { uniqueness: 'server' }),
        attribute('active', 'boolean'),
        attribute('emails', 'complex', {
          multiValued: true,
          subAttributes: [
            attribute('value', 'string'),
            attribute('primary', 'boolean'),
            attribute('type', 'string'),
          ],
        }),
      ],
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: GROUP_SCHEMA,
      name: 'Group',
      attributes: [
        attribute('displayName', 'string', { required: true }),
        attribute('externalId', 'string', { uniqueness: 'server' }),
        attribute('members', 'complex', {
          multiValued: true,
          subAttributes: [attribute('value', 'string')],
        }),
      ],
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: ROLES_EXTENSION,
      name: 'PermDockRoles',
      attributes: [attribute('roles', 'string', { multiValued: true })],
    },
  ];
}
