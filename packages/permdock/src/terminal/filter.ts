import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { CommandEntry, FilterCommandsOptions } from './types.ts';

function snapshotAllows(permdock: PermDock, permission: Permission): boolean {
  const snapshot = permdock.snapshot();
  if (typeof snapshot === 'string' || snapshot instanceof Promise) {
    return false;
  }
  return snapshot.grants.some(
    (grant) => grant.permission === permission.key && grant.effect === 'allow',
  );
}

function commandAllowed(permdock: PermDock, permission: Permission): boolean {
  if (permission.kind === 'collection') {
    // SAFETY: kind is collection, and a collection permission's can() takes no row.
    return (permdock.can as (next: Permission) => boolean)(permission);
  }
  return snapshotAllows(permdock, permission);
}

export function filterCommandEntries(
  permdock: PermDock | undefined,
  entries: readonly CommandEntry[],
  options: FilterCommandsOptions,
): readonly CommandEntry[] {
  const mode = options.mode;
  if (permdock === undefined) {
    if (mode === 'hide') {
      return [];
    }
    return entries.map((entry) => ({
      ...entry,
      description: `${entry.description} (requires ${entry.permission.scope})`,
    }));
  }
  const visible: CommandEntry[] = [];
  for (const entry of entries) {
    const allowed = commandAllowed(permdock, entry.permission);
    if (allowed) {
      visible.push(entry);
      continue;
    }
    if (mode === 'annotate') {
      visible.push({
        ...entry,
        description: `${entry.description} (requires ${entry.permission.scope})`,
      });
    }
  }
  return visible;
}
