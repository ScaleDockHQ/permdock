import type { Scope } from "../../core/scopes.ts";
import type { RlsTable } from "../types.ts";

import { configError } from "../core/errors.ts";
import { permittedIdsHelper } from "./names.ts";

/** The `schema.table` an `rls.tables` entry names, or `resource` when it names none. */
export function tableNameOf(
  entry: RlsTable | undefined,
  resource: string,
): string {
  if (entry === undefined) {
    return resource;
  }
  return typeof entry === "string" ? entry : (entry.table ?? resource);
}

/** `rls.tables` as resource to table name, the `via` objects reduced to their `table`. */
export function tableNames(
  tables: Readonly<Record<string, RlsTable>> | undefined,
): Readonly<Record<string, string>> | undefined {
  return tables === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(tables).map(([resource, entry]) => [
          resource,
          tableNameOf(entry, resource),
        ]),
      );
}

/** An `rls.tables` `via` entry with its defaults filled in. */
export type ResolvedVia = {
  /** `permitted_<parent, singular>_ids`. */
  readonly helper: string;
  /** This table's column holding the parent's id. */
  readonly key: string;
  /** The scope the parent's `column` holds. */
  readonly scope: string;
  /** `schema.table` of the parent. */
  readonly table: string;
  readonly column: string;
  readonly id: string;
  readonly type: string;
};

function singular(name: string): string {
  if (name.endsWith("ies")) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith("sses")) {
    return name.slice(0, -2);
  }
  return name.endsWith("s") && !name.endsWith("ss") ? name.slice(0, -1) : name;
}

/** The `via` entries of `rls.tables`, by resource. */
export function resolveVias(
  tables: Readonly<Record<string, RlsTable>> | undefined,
  scopes: readonly Scope[],
  dialect: string,
): Readonly<Record<string, ResolvedVia>> | undefined {
  const out: Record<string, ResolvedVia> = {};
  for (const [resource, entry] of Object.entries(tables ?? {})) {
    if (typeof entry === "string") {
      continue;
    }
    const { via } = entry;
    const scope = via.scope ?? scopes[0]?.name;
    if (scope === undefined || !scopes.some((item) => item.name === scope)) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.via.scope '${scope ?? ""}' is not a scope of the policy (${scopes.map((item) => item.name).join(", ")})`,
      );
    }
    const bare = via.table.slice(via.table.lastIndexOf(".") + 1);
    const name = singular(bare);
    out[resource] = {
      helper: permittedIdsHelper(name),
      key: via.key ?? `${name}_id`,
      scope,
      table: via.table.includes(".") ? via.table : `public.${via.table}`,
      column: via.column,
      id: via.id ?? "id",
      type: via.type ?? (dialect === "supabase" ? "uuid" : "text"),
    };
  }
  const helpers = new Map<string, ResolvedVia>();
  for (const [resource, via] of Object.entries(out)) {
    const seen = helpers.get(via.helper);
    if (
      seen !== undefined &&
      (seen.table !== via.table ||
        seen.column !== via.column ||
        seen.id !== via.id ||
        seen.scope !== via.scope ||
        seen.type !== via.type)
    ) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.via names ${via.helper}, which another resource defines over a different parent; give the parents different table names`,
      );
    }
    helpers.set(via.helper, via);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
