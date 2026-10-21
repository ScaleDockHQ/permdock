import type { RelationHolder, RelationSource } from "./interfaces.ts";
import type {
  EdgeRelation,
  PermissionTree,
  ResourceNode,
} from "./permission-types.ts";

import { ownGet } from "./paths.ts";
import { getRegistry } from "./permission-registry.ts";
import { relationId } from "./relations.ts";
import {
  groupEntries,
  isComputedRelation,
  isEdgeRelation,
  isPrincipalRelation,
  restrictedStops,
} from "./resource-relations.ts";

export type MemoryEdge = {
  /** The object's id. */
  readonly id: string;
  readonly principal: string;
  readonly startsAt?: number;
  readonly expiresAt?: number;
};

export type MemoryRelationSourceData = {
  /**
   * Rows per resource: parent pointers, links, restricted flags and relation
   * columns are read from them.
   */
  readonly rows?: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  /** Edge-table rows per resource and relation. */
  readonly edges?: Readonly<
    Record<string, Readonly<Record<string, readonly MemoryEdge[]>>>
  >;
  /**
   * Edge tables as the database holds them, keyed by `edge` name: each row is
   * read through the relation's `object`, `subject`, `expiresAt`, `match` and
   * `groups` columns. A relation whose table is here ignores `edges`.
   */
  readonly tables?: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
};

/**
 * The holders one edge-table row names for `spec`: none when the row does not
 * belong to it.
 */
function tableHolders(
  resourceName: string,
  spec: EdgeRelation,
  row: Readonly<Record<string, unknown>>,
  id: string,
): readonly RelationHolder[] {
  if (relationId(ownGet(row, spec.object ?? `${resourceName}_id`)) !== id) {
    return [];
  }
  for (const [column, value] of Object.entries(spec.match ?? {})) {
    if (ownGet(row, column) !== value) {
      return [];
    }
  }
  const expiresAt =
    spec.expiresAt === undefined
      ? undefined
      : seconds(ownGet(row, spec.expiresAt));
  const period = expiresAt === undefined ? {} : { expiresAt };
  const groups = spec.groups;
  const direct = relationId(ownGet(row, spec.subject ?? "user_id"));
  if (groups === undefined) {
    return direct === undefined
      ? []
      : [{ principal: { id: direct }, ...period }];
  }
  if (groups.column === undefined) {
    const out: RelationHolder[] =
      direct === undefined ? [] : [{ principal: { id: direct }, ...period }];
    for (const group of groupEntries(spec)) {
      const groupId = relationId(ownGet(row, group.subject));
      if (groupId !== undefined) {
        out.push({
          group: {
            resource: group.resource,
            id: groupId,
            relation: group.relation,
          },
          ...period,
        });
      }
    }
    return out;
  }
  const kind = ownGet(row, groups.column);
  if (kind === null || kind === undefined || kind === groups.direct) {
    return direct === undefined
      ? []
      : [{ principal: { id: direct }, ...period }];
  }
  const group = groupEntries(spec).find((entry) => entry.resource === kind);
  const groupId =
    group === undefined ? undefined : relationId(ownGet(row, group.subject));
  return group === undefined || groupId === undefined
    ? []
    : [
        {
          group: {
            resource: group.resource,
            id: groupId,
            relation: group.relation,
          },
          ...period,
        },
      ];
}

function seconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time / 1000;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed / 1000;
  }
  return undefined;
}

function restrictedOf(
  node: ResourceNode,
  row: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return (
    node.restricted !== undefined &&
    row !== undefined &&
    ownGet(row, node.restricted) === true
  );
}

function edgeHolder(edge: MemoryEdge): RelationHolder {
  const holder: {
    principal: { id: string };
    startsAt?: number;
    expiresAt?: number;
  } = { principal: { id: edge.principal } };
  if (edge.startsAt !== undefined) {
    holder.startsAt = edge.startsAt;
  }
  if (edge.expiresAt !== undefined) {
    holder.expiresAt = edge.expiresAt;
  }
  return holder;
}

/**
 * An in-process `RelationSource` over plain rows and edges, read against the
 * resource definitions in `permissions`. For tests, fixtures and small apps.
 */
export function memoryRelationSource(
  permissions: PermissionTree,
  data: MemoryRelationSourceData = {},
): RelationSource {
  const registry = getRegistry(permissions);
  const byId = new Map<
    string,
    Map<string, Readonly<Record<string, unknown>>>
  >();
  for (const [name, rows] of Object.entries(data.rows ?? {})) {
    const node = registry.get(name);
    const index = new Map<string, Readonly<Record<string, unknown>>>();
    for (const row of rows) {
      const id = relationId(ownGet(row, node?.id ?? "id"));
      if (id !== undefined) {
        index.set(id, row);
      }
    }
    byId.set(name, index);
  }
  const rowOf = (
    resource: string,
    id: string,
  ): Readonly<Record<string, unknown>> | undefined =>
    byId.get(resource)?.get(id);
  return {
    row({ resource, id }) {
      return rowOf(resource, id) ?? null;
    },
    ancestors({ resource, id, depth, through }) {
      const node = registry.get(resource);
      const start = rowOf(resource, id);
      if (node === undefined || start === undefined) {
        return { ancestors: [] };
      }
      if (through !== "parent") {
        const link = Object.hasOwn(node.links, through)
          ? node.links[through]
          : undefined;
        const next =
          link === undefined
            ? undefined
            : relationId(ownGet(start, link.field));
        if (next === undefined || depth < 1) {
          return { ancestors: [] };
        }
        return { ancestors: [{ id: next }] };
      }
      const restricted = restrictedOf(node, start);
      const stops = restrictedStops(node, "parent");
      if (
        (restricted && stops) ||
        node.parent === undefined ||
        node.parent.resource !== resource
      ) {
        return restricted
          ? { restricted: true, ancestors: [] }
          : { ancestors: [] };
      }
      const field = node.parent.field;
      const seen = new Set([id]);
      const ancestors: {
        readonly id: string;
        readonly restricted?: boolean;
      }[] = [];
      let next = relationId(ownGet(start, field));
      while (next !== undefined && ancestors.length < depth) {
        const row = rowOf(resource, next);
        if (row === undefined) {
          next = undefined;
          break;
        }
        const hidden = restrictedOf(node, row);
        ancestors.push(hidden ? { id: next, restricted: true } : { id: next });
        if (seen.has(next) || (hidden && stops)) {
          next = undefined;
          break;
        }
        seen.add(next);
        next = relationId(ownGet(row, field));
      }
      const chain = restricted
        ? { restricted: true, ancestors }
        : { ancestors };
      return next === undefined || rowOf(resource, next) === undefined
        ? chain
        : { ...chain, truncated: true };
    },
    related({ resource, id, relation }) {
      const spec = registry.get(resource)?.relations[relation];
      if (spec === undefined || isComputedRelation(spec)) {
        return [];
      }
      if (isEdgeRelation(spec)) {
        const table = data.tables?.[spec.edge];
        if (table !== undefined) {
          return table.flatMap((row) => tableHolders(resource, spec, row, id));
        }
        return (data.edges?.[resource]?.[relation] ?? [])
          .filter((edge) => edge.id === id)
          .map(edgeHolder);
      }
      const row = rowOf(resource, id);
      if (row === undefined) {
        return [];
      }
      if (isPrincipalRelation(spec)) {
        const holder = relationId(ownGet(row, spec.principal));
        if (holder === undefined) {
          return [];
        }
        const startsAt =
          spec.period?.startsAt === undefined
            ? undefined
            : seconds(ownGet(row, spec.period.startsAt));
        const expiresAt =
          spec.period?.expiresAt === undefined
            ? undefined
            : seconds(ownGet(row, spec.period.expiresAt));
        return [
          {
            principal: { id: holder },
            ...(startsAt === undefined ? {} : { startsAt }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        ];
      }
      if (spec.memberOf !== undefined) {
        return [];
      }
      const holder = relationId(ownGet(row, spec.field));
      return holder === undefined ? [] : [{ principal: { id: holder } }];
    },
  };
}
