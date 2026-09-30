import type { ScimPatchOp } from './types.ts';

import { isReadonlyArray } from '../core/compact.ts';
import { ROLES_EXTENSION } from './types.ts';

const FILTER_PATH =
  /^(?<attribute>[A-Za-z0-9._]+)\[(?<field>[A-Za-z0-9._]+)\s+eq\s+"(?<value>[^"]+)"\](?<rest>\.[A-Za-z0-9._]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function coerceActive(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
  }
  return undefined;
}

function rolesPath(path: string): boolean {
  return (
    path === 'roles' ||
    path === `${ROLES_EXTENSION}:roles` ||
    path === `${ROLES_EXTENSION}.roles`
  );
}

function opName(value: unknown): 'add' | 'replace' | 'remove' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === 'add' || lower === 'replace' || lower === 'remove') {
    return lower;
  }
  return undefined;
}

export function normalizePatchOps(
  ops: readonly unknown[],
): readonly ScimPatchOp[] | undefined {
  const next: ScimPatchOp[] = [];
  for (const raw of ops) {
    if (!isRecord(raw)) {
      return undefined;
    }
    const op = opName(raw['op']);
    if (op === undefined) {
      return undefined;
    }
    const path = typeof raw['path'] === 'string' ? raw['path'] : undefined;
    if (path === undefined) {
      if (!isRecord(raw['value'])) {
        next.push({ op, value: raw['value'] });
        continue;
      }
      for (const [key, value] of Object.entries(raw['value'])) {
        if (key === ROLES_EXTENSION && isRecord(value)) {
          next.push({ op, path: 'roles', value: value['roles'] });
          continue;
        }
        if (key === 'active') {
          next.push({
            op,
            path: 'active',
            value: coerceActive(value) ?? value,
          });
          continue;
        }
        next.push({ op, path: key, value });
      }
      continue;
    }
    if (rolesPath(path)) {
      const roles = isRecord(raw['value'])
        ? raw['value']['roles']
        : raw['value'];
      next.push({ op, path: 'roles', value: roles });
      continue;
    }
    const filtered = FILTER_PATH.exec(path);
    if (filtered?.groups !== undefined) {
      const attribute = filtered.groups['attribute'];
      const field = filtered.groups['field'];
      const value = filtered.groups['value'];
      if (
        attribute === undefined ||
        field === undefined ||
        value === undefined
      ) {
        return undefined;
      }
      if (op === 'remove') {
        next.push({
          op,
          path: attribute,
          value: [{ [field]: value }],
        });
        continue;
      }
      next.push({
        op,
        path: attribute,
        value: raw['value'] ?? [{ [field]: value }],
      });
      continue;
    }
    if (path === 'active') {
      next.push({
        op,
        path,
        value: coerceActive(raw['value']) ?? raw['value'],
      });
      continue;
    }
    next.push({ op, path, value: raw['value'] });
  }
  return next;
}

export function readPatchOperations(
  body: unknown,
): readonly unknown[] | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const operations = body['Operations'] ?? body['operations'];
  if (!isReadonlyArray(operations)) {
    return undefined;
  }
  return operations;
}
