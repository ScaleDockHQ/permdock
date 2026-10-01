import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DRAFT_PINS } from '../openapi/pins.ts';
import { packageRoot } from './package-root.ts';

export type OpenapiVersion = '3.1' | '3.2' | '3.3';

function schemaDir(): string {
  return join(packageRoot(), 'schemas', 'openapi');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const validators = new Map<string, ValidateFunction>();

function schemaFile(file: string): Record<string, unknown> {
  // Ajv resolves `$dynamicRef: #meta` against the root rather than the
  // `$dynamicAnchor` in `$defs`; with no dialect override the two are the same.
  const text = readFileSync(join(schemaDir(), file), 'utf8').replaceAll(
    '"$dynamicRef": "#meta"',
    '"$ref": "#/$defs/schema"',
  );
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new TypeError(`PermDock CLI: ${file} is not a JSON Schema`);
  }
  return parsed;
}

function child(
  parent: Record<string, unknown>,
  ...path: readonly string[]
): Record<string, unknown> {
  let node = parent;
  for (const key of path) {
    const next = node[key];
    if (!isRecord(next)) {
      throw new TypeError(
        `PermDock CLI: OpenAPI schema has no ${path.join('.')}`,
      );
    }
    node = next;
  }
  return node;
}

const STRINGS = { type: 'array', items: { type: 'string' } } as const;

/**
 * No official 3.3 schema exists: the 3.2 schema plus the pinned draft's
 * Security Profiles (a `profile` scheme type and
 * `components.securityProfileRequirements`).
 */
function oas33Schema(): Record<string, unknown> {
  const schema = schemaFile('oas-3.2.json');
  schema['$id'] =
    `https://permdock.dev/schemas/openapi/oas-3.3/${DRAFT_PINS.oas}`;
  child(schema, 'properties', 'openapi')['pattern'] =
    String.raw`^3\.3\.\d+(-.+)?$`;
  const defs = child(schema, '$defs');
  const scheme = child(defs, 'security-scheme');
  const type = child(scheme, 'properties', 'type');
  type['enum'] = [
    ...(Array.isArray(type['enum']) ? type['enum'] : []),
    'profile',
  ];
  const allOf = Array.isArray(scheme['allOf']) ? scheme['allOf'] : [];
  scheme['allOf'] = [
    ...allOf,
    {
      if: { properties: { type: { const: 'profile' } } },
      // oxlint-disable-next-line unicorn/no-thenable -- the JSON Schema `then` keyword
      then: {
        properties: {
          profileMetadata: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              supportedParametersSchema: { type: ['string', 'object'] },
              supportedOperations: {},
              servers: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    name: { type: 'string' },
                    url: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        required: ['profileMetadata'],
      },
    },
  ];
  child(defs, 'components', 'properties')['securityProfileRequirements'] = {
    type: 'object',
    additionalProperties: {
      type: 'object',
      required: ['securityScheme', 'scopes'],
      properties: {
        securityScheme: { $ref: '#/$defs/reference' },
        token_endpoint_auth_methods: STRINGS,
        grant_types: STRINGS,
        scopes: STRINGS,
      },
    },
  };
  return schema;
}

function validatorFor(file: string): ValidateFunction {
  const cached = validators.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const ajv = new Ajv2020({
    strict: false,
    allErrors: false,
    validateFormats: false,
  });
  const compiled = ajv.compile(
    file === 'oas-3.3.json' ? oas33Schema() : schemaFile(file),
  );
  validators.set(file, compiled);
  return compiled;
}

function describeErrors(errors: readonly ErrorObject[] | null | undefined) {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `  ${error.instancePath || '/'} ${error.message ?? ''}`)
    .join('\n');
}

/** Validates an OpenAPI 3.1 or 3.2 document against the official JSON Schema, and 3.3 against the pinned patch of 3.2. */
export function validateOpenapi(
  document: unknown,
):
  | { readonly ok: true; readonly version: OpenapiVersion }
  | { readonly ok: false; readonly error: string } {
  const version = isRecord(document) ? document['openapi'] : undefined;
  const match =
    typeof version === 'string' ? /^3\.([123])\.\d+$/u.exec(version) : null;
  if (match === null) {
    return {
      ok: false,
      error: 'expected an OpenAPI 3.1, 3.2 or 3.3 document',
    };
  }
  const minor = match[1] === '1' ? '3.1' : match[1] === '2' ? '3.2' : '3.3';
  const validate = validatorFor(`oas-${minor}.json`);
  if (!validate(document)) {
    return {
      ok: false,
      error: `document is not valid OpenAPI ${minor}:\n${describeErrors(validate.errors)}`,
    };
  }
  return { ok: true, version: minor };
}

/** Validates an Overlay 1.1 document against the official JSON Schema. */
export function validateOverlay(
  document: unknown,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const validate = validatorFor('overlay-1.1.json');
  return validate(document)
    ? { ok: true }
    : {
        ok: false,
        error: `document is not a valid Overlay 1.1:\n${describeErrors(validate.errors)}`,
      };
}
