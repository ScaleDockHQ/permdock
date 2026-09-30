import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageRoot } from './package-root.ts';

export type OpenapiVersion = '3.1' | '3.2';

function schemaDir(): string {
  return join(packageRoot(), 'schemas', 'openapi');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const validators = new Map<string, ValidateFunction>();

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
  // Ajv resolves `$dynamicRef: #meta` against the root rather than the
  // `$dynamicAnchor` in `$defs`; with no dialect override the two are the same.
  const text = readFileSync(join(schemaDir(), file), 'utf8').replaceAll(
    '"$dynamicRef": "#meta"',
    '"$ref": "#/$defs/schema"',
  );
  const compiled = ajv.compile(JSON.parse(text) as object);
  validators.set(file, compiled);
  return compiled;
}

function describeErrors(errors: readonly ErrorObject[] | null | undefined) {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `  ${error.instancePath || '/'} ${error.message ?? ''}`)
    .join('\n');
}

/** Validates an OpenAPI 3.1 or 3.2 document against the official JSON Schema. */
export function validateOpenapi(
  document: unknown,
):
  | { readonly ok: true; readonly version: OpenapiVersion }
  | { readonly ok: false; readonly error: string } {
  const version = isRecord(document) ? document['openapi'] : undefined;
  const match =
    typeof version === 'string' ? /^3\.([12])\.\d+$/u.exec(version) : null;
  if (match === null) {
    return {
      ok: false,
      error: 'expected an OpenAPI 3.1 or 3.2 document',
    };
  }
  const minor = match[1] === '1' ? '3.1' : '3.2';
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
