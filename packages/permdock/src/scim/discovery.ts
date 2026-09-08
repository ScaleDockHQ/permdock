import { GROUP_SCHEMA, ROLES_EXTENSION, USER_SCHEMA } from './types.ts';

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

export function schemas(): readonly Record<string, unknown>[] {
  return [
    {
      id: USER_SCHEMA,
      name: 'User',
      attributes: [
        {
          name: 'userName',
          type: 'string',
          required: true,
          uniqueness: 'server',
        },
        { name: 'externalId', type: 'string', uniqueness: 'server' },
        { name: 'active', type: 'boolean' },
        {
          name: 'emails',
          type: 'complex',
          multiValued: true,
          subAttributes: [
            { name: 'value', type: 'string' },
            { name: 'primary', type: 'boolean' },
            { name: 'type', type: 'string' },
          ],
        },
      ],
    },
    {
      id: GROUP_SCHEMA,
      name: 'Group',
      attributes: [
        { name: 'displayName', type: 'string', required: true },
        { name: 'externalId', type: 'string', uniqueness: 'server' },
        {
          name: 'members',
          type: 'complex',
          multiValued: true,
          subAttributes: [{ name: 'value', type: 'string' }],
        },
      ],
    },
    {
      id: ROLES_EXTENSION,
      name: 'PermDockRoles',
      attributes: [{ name: 'roles', type: 'string', multiValued: true }],
    },
  ];
}
