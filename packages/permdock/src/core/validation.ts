import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Permission, ResourceNode } from './permissions.ts';

import { PermDockValidationError } from './errors.ts';

export type Boundary =
  | 'http-body'
  | 'mcp-args'
  | 'tool-args'
  | 'decision-endpoint'
  | 'manual';

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

export function validateBoundary(
  permission: Permission,
  resource: ResourceNode | undefined,
  data: unknown,
  mode: 'boundary' | 'always' | 'never',
  trusted: boolean,
  boundary: Boundary = 'manual',
): unknown {
  const shouldValidate = mode === 'always' || (mode === 'boundary' && !trusted);
  if (!shouldValidate) {
    return data;
  }
  if (resource?.schema === undefined) {
    if (mode === 'always') {
      throw new PermDockValidationError({
        code: 'no-schema',
        permission: permission.key,
        resource: permission.resource,
        boundary,
        message: `${permission.key}: no schema for resource ${permission.resource}.`,
      });
    }
    return data;
  }
  const result = resource.schema['~standard'].validate(data);
  if (isThenable(result)) {
    throw new PermDockValidationError({
      code: 'async-schema',
      permission: permission.key,
      resource: permission.resource,
      boundary,
      message: `${permission.key}: schema for ${permission.resource} is async.`,
    });
  }
  if ('issues' in result && result.issues !== undefined) {
    throw new PermDockValidationError({
      code: 'invalid-data',
      permission: permission.key,
      resource: permission.resource,
      issues: result.issues,
      boundary,
      message: validationMessage(permission, resource, result.issues),
    });
  }
  return (result as { readonly value: unknown }).value;
}

function validationMessage(
  permission: Permission,
  resource: ResourceNode,
  issues: readonly StandardSchemaV1.Issue[],
): string {
  const parts = issues.map((issue) => {
    const path =
      issue.path
        ?.map((item) =>
          typeof item === 'object' && 'key' in item
            ? String(item.key)
            : String(item),
        )
        .join('.') ?? '/';
    return `invalid ${resource.name} data at ${path}: ${issue.message}`;
  });
  return `${permission.key}: ${parts.join('; ')}.`;
}
