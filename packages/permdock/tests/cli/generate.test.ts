import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  GeneratedResource,
  JsonSchema,
  SchemaKind,
} from '../../src/cli/generate.ts';
import type { PermissionTree } from '../../src/index.ts';

import {
  emitPermissionsModule,
  emptySchema,
  isSchemaKind,
  schemaExpression,
} from '../../src/cli/generate.ts';
import { getResource, listPermissions } from '../../src/index.ts';

const TMP = path.join(import.meta.dirname, '../../tmp');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function nested(depth: number): JsonSchema {
  let schema: JsonSchema = { type: 'string' };
  for (let level = 0; level < depth; level += 1) {
    schema = { type: 'array', items: schema };
  }
  return schema;
}

const CASES: readonly (readonly [
  string,
  JsonSchema,
  Readonly<Record<SchemaKind, string>>,
])[] = [
  [
    'string',
    { type: 'string' },
    { zod: 'z.string()', valibot: 'v.string()', arktype: "type('string')" },
  ],
  [
    'number',
    { type: 'number' },
    { zod: 'z.number()', valibot: 'v.number()', arktype: "type('number')" },
  ],
  [
    'integer',
    { type: 'integer' },
    {
      zod: 'z.number().int()',
      valibot: 'v.pipe(v.number(), v.integer())',
      arktype: "type('number.integer')",
    },
  ],
  [
    'boolean',
    { type: 'boolean' },
    { zod: 'z.boolean()', valibot: 'v.boolean()', arktype: "type('boolean')" },
  ],
  [
    'nullable type list',
    { type: ['string', 'null'] },
    { zod: 'z.string()', valibot: 'v.string()', arktype: "type('string')" },
  ],
  [
    'ambiguous type list',
    { type: ['string', 'number'] },
    { zod: 'z.unknown()', valibot: 'v.unknown()', arktype: "type('unknown')" },
  ],
  [
    'non-portable type',
    { type: 'null' },
    { zod: 'z.unknown()', valibot: 'v.unknown()', arktype: "type('unknown')" },
  ],
  [
    'no type',
    {},
    { zod: 'z.unknown()', valibot: 'v.unknown()', arktype: "type('unknown')" },
  ],
  [
    'string enum',
    { enum: ['draft', "it's"] },
    {
      zod: `z.enum(["draft","it's"])`,
      valibot: `v.picklist(["draft","it's"])`,
      arktype: String.raw`type("'draft' | 'it\\'s'")`,
    },
  ],
  [
    'mixed enum',
    { type: 'string', enum: ['a', 1] },
    { zod: 'z.string()', valibot: 'v.string()', arktype: "type('string')" },
  ],
  [
    'empty enum',
    { type: 'boolean', enum: [] },
    { zod: 'z.boolean()', valibot: 'v.boolean()', arktype: "type('boolean')" },
  ],
  [
    'array of strings',
    { type: 'array', items: { type: 'string' } },
    {
      zod: 'z.array(z.string())',
      valibot: 'v.array(v.string())',
      arktype: "type('string[]')",
    },
  ],
  [
    'array without items',
    { type: 'array' },
    {
      zod: 'z.array(z.unknown())',
      valibot: 'v.array(v.unknown())',
      arktype: "type('unknown[]')",
    },
  ],
  [
    'array of enums',
    { type: 'array', items: { enum: ['a', 'b'] } },
    {
      zod: 'z.array(z.enum(["a","b"]))',
      valibot: 'v.array(v.picklist(["a","b"]))',
      arktype: `type(["'a' | 'b'", '[]'])`,
    },
  ],
  [
    'array of objects',
    { type: 'array', items: { type: 'object' } },
    {
      zod: 'z.array(z.object({}))',
      valibot: 'v.array(v.object({}))',
      arktype: "type([{}, '[]'])",
    },
  ],
  [
    'object with required, optional and quoted keys',
    {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        'first-name': { type: 'string' },
        skipped: true,
      },
    },
    {
      zod: 'z.object({ id: z.string(), "first-name": z.string().optional() })',
      valibot:
        'v.object({ id: v.string(), "first-name": v.optional(v.string()) })',
      arktype: `type({ "id": 'string', "first-name?": 'string' })`,
    },
  ],
  [
    'object inferred from properties',
    { properties: { n: { type: 'number' } }, required: 'n' },
    {
      zod: 'z.object({ n: z.number().optional() })',
      valibot: 'v.object({ n: v.optional(v.number()) })',
      arktype: `type({ "n?": 'number' })`,
    },
  ],
  [
    'object without properties',
    { type: 'object', properties: [] },
    {
      zod: 'z.object({})',
      valibot: 'v.object({})',
      arktype: 'type({})',
    },
  ],
  [
    'nesting past the depth limit',
    nested(8),
    {
      zod: `${'z.array('.repeat(7)}z.unknown()${')'.repeat(7)}`,
      valibot: `${'v.array('.repeat(7)}v.unknown()${')'.repeat(7)}`,
      arktype: "type('unknown[][][][][][][]')",
    },
  ],
];

describe('schemaExpression', () => {
  it.each(CASES)('translates %s', (_label, schema, expected) => {
    expect({
      zod: schemaExpression('zod', schema),
      valibot: schemaExpression('valibot', schema),
      arktype: schemaExpression('arktype', schema),
    }).toEqual(expected);
  });

  it('resolves references through the resolver at every level', () => {
    const shared: JsonSchema = {
      type: 'object',
      required: ['tags'],
      properties: {
        tags: { type: 'array', items: { $ref: 'Tag' } },
      },
    };
    const resolve = (node: JsonSchema): JsonSchema =>
      node['$ref'] === 'Root'
        ? shared
        : node['$ref'] === 'Tag'
          ? { type: 'string' }
          : node;
    expect({
      zod: schemaExpression('zod', { $ref: 'Root' }, resolve),
      valibot: schemaExpression('valibot', { $ref: 'Root' }, resolve),
      arktype: schemaExpression('arktype', { $ref: 'Root' }, resolve),
    }).toEqual({
      zod: 'z.object({ tags: z.array(z.string()) })',
      valibot: 'v.object({ tags: v.array(v.string()) })',
      arktype: `type({ "tags": 'string[]' })`,
    });
  });

  it('gives an empty object for emptySchema', () => {
    expect({
      zod: emptySchema('zod'),
      valibot: emptySchema('valibot'),
      arktype: emptySchema('arktype'),
    }).toEqual({
      zod: 'z.object({})',
      valibot: 'v.object({})',
      arktype: 'type({})',
    });
  });
});

describe('isSchemaKind', () => {
  it.each([
    ['zod', true],
    ['valibot', true],
    ['arktype', true],
    ['yup', false],
    ['', false],
    [undefined, false],
  ] as const)('%s is %s', (value, expected) => {
    expect(isSchemaKind(value)).toBe(expected);
  });
});

const RESOURCES: readonly GeneratedResource[] = [
  {
    path: ['org', 'post'],
    id: "slug'\\x",
    actions: { read: { title: 'Read', readOnly: true } },
    collection: ['create'],
  },
  { path: ['org', 'member'], actions: ['remove'], collection: [] },
  { path: ['billing-account'], actions: [], collection: ['list'] },
];

describe('emitPermissionsModule', () => {
  it('writes a sorted, deterministic module with a generated header', () => {
    const text = emitPermissionsModule({
      generator: 'test',
      schema: undefined,
      resources: RESOURCES,
      exports: { tables: ['a', 'b'] },
    });
    expect(text).toBe(
      `// @generated by permdock test
import { definePermissions, resource } from 'permdock'

export const tables = [
  "a",
  "b"
] as const

export const permissions = definePermissions({
  "billing-account": resource({
    id: 'id',
    actions: [],
    collection: ["list"],
  }),
  org: {
    member: resource({
      id: 'id',
      actions: ["remove"],
      collection: [],
    }),
    post: resource({
      id: 'slug\\'\\\\x',
      actions: {
        "read": {
          "title": "Read",
          "readOnly": true
        }
      },
      collection: ["create"],
    }),
  },
})
`,
    );
    expect(
      emitPermissionsModule({
        generator: 'test',
        schema: undefined,
        resources: [...RESOURCES].toReversed(),
        exports: { tables: ['a', 'b'] },
      }),
    ).toBe(text);
  });

  it.each([
    ['zod', "import { z } from 'zod'"],
    ['valibot', "import * as v from 'valibot'"],
    ['arktype', "import { type } from 'arktype'"],
  ] as const)('imports the %s validator', (kind, line) => {
    const text = emitPermissionsModule({
      generator: 'test',
      schema: kind,
      resources: [
        {
          path: ['post'],
          schema: emptySchema(kind),
          actions: ['read'],
          collection: [],
        },
      ],
    });
    expect(text.split('\n').slice(1, 3)).toEqual([
      "import { definePermissions, resource } from 'permdock'",
      line,
    ]);
    expect(text).toContain(`post: resource(${emptySchema(kind)}, {`);
  });

  it.each(['zod', 'valibot'] as const)(
    'emits a %s module that loads and validates',
    async (kind) => {
      mkdirSync(TMP, { recursive: true });
      const dir = mkdtempSync(path.join(TMP, 'generate-'));
      temps.push(dir);
      const file = path.join(dir, `permissions.${kind}.ts`);
      writeFileSync(
        file,
        emitPermissionsModule({
          generator: 'test',
          schema: kind,
          resources: [
            {
              path: ['post'],
              schema: schemaExpression(kind, {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string' },
                  views: { type: 'integer' },
                  status: { enum: ['draft', 'live'] },
                },
              }),
              actions: ['read'],
              collection: ['list'],
            },
          ],
        }),
      );
      // SAFETY: the module was emitted above and exports `permissions`.
      const module = (await import(pathToFileURL(file).href)) as {
        readonly permissions: PermissionTree;
      };
      expect(
        listPermissions(module.permissions).map((leaf) => [
          leaf.key,
          leaf.kind,
        ]),
      ).toEqual([
        ['post.read', 'instance'],
        ['post.list', 'collection'],
      ]);
      const schema = getResource(module.permissions, 'post')?.schema;
      const validate = async (value: unknown) => {
        const result = await schema?.['~standard'].validate(value);
        return result?.issues === undefined;
      };
      expect({
        valid: await validate({ id: '1', views: 2, status: 'draft' }),
        fraction: await validate({ id: '1', views: 1.5 }),
        missingId: await validate({ status: 'live' }),
        badEnum: await validate({ id: '1', status: 'gone' }),
      }).toEqual({
        valid: true,
        fraction: false,
        missingId: false,
        badEnum: false,
      });
    },
  );
});
