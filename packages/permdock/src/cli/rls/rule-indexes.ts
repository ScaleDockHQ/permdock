import type { Policy } from "../../index.ts";
import type { RlsApprovalManagers, RlsTable, RlsTableOwner } from "../types.ts";
import type { IndexTarget } from "./indexes.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { tableNameOf } from "../sql/tables.ts";

function isOwner(entry: RlsTable): entry is RlsTableOwner {
  return typeof entry === "object" && !("tableOf" in entry);
}

/**
 * The indexes the generated rules read through, beyond the scope keys: the
 * foreign key of each `follows` child, the parent and user columns of a
 * recursive `walk`, and the manager table's user and manager columns, each led
 * by the column the walk compares and followed by the edge's tenant.
 */
export function ruleIndexTargets(
  policy: Policy,
  config: {
    readonly tables?: Readonly<Record<string, RlsTable>>;
    readonly managers?: RlsApprovalManagers;
  },
): readonly IndexTarget[] {
  const out: IndexTarget[] = [];
  const add = (table: string, columns: readonly string[]): void => {
    out.push({ table: qualifySqlTable(table), columns });
  };
  for (const [name, entry] of Object.entries(config.tables ?? {})) {
    if (!isOwner(entry)) {
      continue;
    }
    for (const [child, column] of Object.entries(entry.follows ?? {})) {
      add(child, [column]);
    }
    if (entry.walk === "recursive") {
      const node = policy.resources.get(name);
      const table = tableNameOf(entry, name, config.tables);
      if (node?.parent !== undefined) {
        add(table, [node.parent.field]);
      }
      add(table, [entry.user ?? node?.id ?? "id"]);
    }
  }
  const managers = config.managers;
  if (managers !== undefined) {
    const tenant = managers.tenant === undefined ? [] : [managers.tenant];
    add(managers.table, [managers.user, ...tenant]);
    add(managers.table, [managers.manager, ...tenant]);
  }
  return out;
}

/**
 * `targets` without a second index on the same table and leading columns, in a
 * stable order.
 */
export function mergeIndexTargets(
  ...lists: readonly (readonly IndexTarget[])[]
): readonly IndexTarget[] {
  const seen = new Map<string, IndexTarget>();
  for (const target of lists.flat()) {
    const key = `${target.table}\u0000${target.columns.join("\u0000")}\u0000${target.where ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, target);
    }
  }
  return [...seen.values()].toSorted((a, b) => {
    const left = `${a.table}.${a.columns.join(",")}`;
    const right = `${b.table}.${b.columns.join(",")}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
