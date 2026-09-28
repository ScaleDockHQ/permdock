import type { Permission, PermissionTree, Policy } from 'permdock';

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPermissions } from 'permdock';

export async function loadModule(
  abs: string,
): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(pathToFileURL(abs).href);
  if (loaded === null || typeof loaded !== 'object') {
    throw new Error(`PermDock CLI: module '${abs}' did not export an object`);
  }
  return loaded as Record<string, unknown>;
}

export function pickNamed(
  mod: Readonly<Record<string, unknown>>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    if (name in mod) {
      return mod[name];
    }
  }
  return mod.default;
}

export function asPermissionTree(value: unknown): PermissionTree {
  if (value === null || typeof value !== 'object') {
    throw new Error(
      'PermDock CLI: permissions export is not a permission tree',
    );
  }
  return value as PermissionTree;
}

export function asPolicy(value: unknown): Policy {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('roles' in value) ||
    !('permissions' in value)
  ) {
    throw new Error('PermDock CLI: policy export is not a Policy');
  }
  return value as Policy;
}

export function leavesOf(tree: PermissionTree): readonly Permission[] {
  return listPermissions(tree);
}

/** The configured policy export, or `undefined` when unset or unloadable. */
export async function loadConfiguredPolicy(
  cwd: string,
  path: string | undefined,
): Promise<Policy | undefined> {
  if (path === undefined) {
    return undefined;
  }
  try {
    return asPolicy(
      pickNamed(await loadModule(resolve(cwd, path)), ['policy']),
    );
  } catch {
    return undefined;
  }
}
