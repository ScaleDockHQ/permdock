import { freezeDeep } from './freeze.ts';
import { isForbiddenKey, ownGet, ownKeys } from './paths.ts';

export function sanitizeFields(
  fields: readonly string[] | undefined,
): readonly string[] | undefined {
  if (fields === undefined) {
    return undefined;
  }
  return fields.filter((field) => field.length > 0 && !isForbiddenKey(field));
}

export function grantCoversField(
  fields: readonly string[] | undefined,
  field: string | undefined,
  effect: 'allow' | 'deny',
): boolean {
  if (fields === undefined) {
    return true;
  }
  if (fields.length === 0) {
    return false;
  }
  if (field === undefined) {
    return effect === 'allow';
  }
  return fields.includes(field);
}

export function pickVisible<T extends object>(
  row: T,
  canField: (field: string) => boolean,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of ownKeys(row)) {
    if (canField(key)) {
      out[key] = ownGet(row, key);
    }
  }
  return freezeDeep(out) as Partial<T>;
}

export function sanitizeContext(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    out[key] = ownGet(value, key);
  }
  return out;
}
