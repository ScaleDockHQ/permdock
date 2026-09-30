import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { CommandEntry, FilterCommandsOptions } from './types.ts';

function snapshotAllows(dock: PermDock, permission: Permission): boolean {
  const snapshot = dock.snapshot();
  if (typeof snapshot === 'string' || snapshot instanceof Promise) {
    return false;
  }
  return snapshot.grants.some(
    (grant) => grant.permission === permission.key && grant.effect === 'allow',
  );
}

function commandAllowed(dock: PermDock, permission: Permission): boolean {
  if (permission.kind === 'collection') {
    // SAFETY: kind is collection, and a collection permission's can() takes no row.
    return (dock.can as (next: Permission) => boolean)(permission);
  }
  return snapshotAllows(dock, permission);
}

export function filterCommandEntries(
  dock: PermDock | undefined,
  entries: readonly CommandEntry[],
  options: FilterCommandsOptions,
): readonly CommandEntry[] {
  const mode = options.mode;
  if (dock === undefined) {
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
    const allowed = commandAllowed(dock, entry.permission);
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
