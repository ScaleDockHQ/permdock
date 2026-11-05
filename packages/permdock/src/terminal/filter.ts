import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { CommandEntry, FilterCommandsOptions } from "./types.ts";

import { expandSnapshot } from "../core/snapshot-compact.ts";

function snapshotAllows(permdock: PermDock, permission: Permission): boolean {
  const wire: Snapshot | Promise<string> | string = permdock.snapshot();
  if (typeof wire === "string" || wire instanceof Promise) {
    return false;
  }
  return expandSnapshot(wire).grants.some(
    (grant) => grant.permission === permission.key && grant.effect === "allow",
  );
}

function commandAllowed(permdock: PermDock, permission: Permission): boolean {
  if (permission.kind === "collection") {
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
    if (mode === "hide") {
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
    if (mode === "annotate") {
      visible.push({
        ...entry,
        description: `${entry.description} (requires ${entry.permission.scope})`,
      });
    }
  }
  return visible;
}
