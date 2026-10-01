import { freezeDeep } from '../core/freeze.ts';

/** The JSON Schema keywords `catalogSchema` uses; `checkSchema` interprets exactly these. */
export type CatalogSchemaNode = {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: 'object' | 'array' | 'string' | 'boolean' | 'integer';
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, CatalogSchemaNode>>;
  readonly additionalProperties?: CatalogSchemaNode;
  readonly items?: CatalogSchemaNode;
  readonly oneOf?: readonly CatalogSchemaNode[];
};

const name = { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } as const;
const strings = { type: 'array', items: { type: 'string' } } as const;

/** `schemas/catalog-v1.json`; a test keeps the two equal. */
export const catalogSchema: CatalogSchemaNode = freezeDeep({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://permdock.dev/schemas/catalog-v1.json',
  type: 'object',
  required: [
    '$schema',
    'version',
    'generatedAt',
    'generator',
    'resources',
    'permissions',
  ],
  properties: {
    $schema: { type: 'string' },
    version: { const: 1 },
    generatedAt: { type: 'string' },
    generator: { type: 'string' },
    fingerprint: { type: 'string' },
    resources: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['id', 'schema'],
        properties: {
          id: { type: 'string' },
          schema: {},
          definedIn: { type: 'string' },
          relations: { type: 'object' },
          version: { type: 'string' },
          restricted: { type: 'string' },
        },
      },
    },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
          on: name,
          assignable: { type: 'boolean' },
          min: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
          transferOnly: { const: true },
          assigns: strings,
          for: strings,
          exclusiveWith: strings,
          audience: { type: 'string' },
          activation: {
            type: 'object',
            required: ['justification'],
            properties: {
              maxDuration: { type: 'string' },
              justification: { enum: ['required', 'optional'] },
              approval: { type: 'boolean' },
              assurance: { type: 'object' },
            },
          },
          supportAccess: {
            type: 'object',
            required: ['actorRequired', 'group', 'durations'],
            properties: {
              actorRequired: { type: 'boolean' },
              group: { type: 'string' },
              durations: strings,
            },
          },
        },
      },
    },
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'key'],
        properties: {
          name,
          key: { type: 'string' },
          within: { type: 'string' },
        },
      },
    },
    plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string' } },
      },
    },
    permissions: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'key',
          'scope',
          'resource',
          'action',
          'arity',
          'meta',
          'usages',
        ],
        properties: {
          key: { type: 'string' },
          scope: { type: 'string' },
          resource: { type: 'string' },
          action: { type: 'string' },
          arity: { enum: ['instance', 'collection'] },
          meta: { type: 'object' },
          usages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file', 'line', 'call'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer', minimum: 0 },
                call: { type: 'string' },
              },
            },
          },
          hostable: { const: true },
          rowConditions: { type: 'boolean' },
          approvals: {
            type: 'array',
            items: {
              oneOf: [
                { const: 'human' },
                {
                  type: 'object',
                  properties: {
                    by: {},
                    distinct: { type: 'boolean' },
                    staleOn: { const: 'resource-change' },
                  },
                },
              ],
            },
          },
          breakGlass: {
            type: 'object',
            required: ['overrides', 'reason', 'obligations'],
            properties: {
              overrides: strings,
              purpose: strings,
              reason: { type: 'boolean' },
              maxDuration: { type: 'string' },
              obligations: strings,
            },
          },
        },
      },
    },
  },
});
