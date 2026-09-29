import type { RelatedCondition } from '../conditions/ast.ts';
import type {
  RelationChain,
  RelationHolder,
  RelationSource,
} from './interfaces.ts';
import type { PermissionTree, ResourceNode } from './permissions.ts';
import type { Subject } from './subject.ts';

import { ownGet } from './paths.ts';
import {
  getRegistry,
  isEdgeRelation,
  isPrincipalRelation,
} from './permissions.ts';
import { isThenable } from './thenable.ts';

type CacheEntry =
  | { readonly state: 'ready'; readonly value: unknown }
  | { readonly state: 'pending'; readonly promise: Promise<void> }
  | { readonly state: 'failed' };

/** One instance's relation facts, keyed by query. Lives on the instance, never at module level. */
export type RelationCache = Map<string, CacheEntry>;

export type Unread = 'pending' | 'failed';

/** Synchronous reads over a `RelationSource` and the instance's cache. */
export type RelationReader = {
  chain(query: {
    readonly resource: string;
    readonly id: string;
    readonly depth: number;
  }): RelationChain | Unread;
  holders(query: {
    readonly resource: string;
    readonly id: string;
    readonly relation: string;
  }): readonly RelationHolder[] | Unread;
};

export type RelatedVerdict =
  | boolean
  | 'relation-depth'
  | 'relation-unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInstant(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isFinite(value))
  );
}

function asChain(value: unknown): RelationChain | undefined {
  if (!isRecord(value) || !Array.isArray(value.ancestors)) {
    return undefined;
  }
  const ancestors: { readonly id: string; readonly restricted?: boolean }[] =
    [];
  for (const item of value.ancestors as readonly unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') {
      return undefined;
    }
    ancestors.push(
      item.restricted === true
        ? { id: item.id, restricted: true }
        : { id: item.id },
    );
  }
  return {
    ancestors,
    ...(value.restricted === true ? { restricted: true } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

function asHolders(value: unknown): readonly RelationHolder[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const holders: RelationHolder[] = [];
  for (const item of value as readonly unknown[]) {
    if (
      !isRecord(item) ||
      !isRecord(item.principal) ||
      typeof item.principal.id !== 'string' ||
      !isInstant(item.startsAt) ||
      !isInstant(item.expiresAt)
    ) {
      return undefined;
    }
    holders.push({
      principal: { id: item.principal.id },
      ...(item.startsAt === undefined
        ? {}
        : { startsAt: item.startsAt as number }),
      ...(item.expiresAt === undefined
        ? {}
        : { expiresAt: item.expiresAt as number }),
    });
  }
  return holders;
}

function read<T>(
  cache: RelationCache,
  key: string,
  call: (() => unknown) | undefined,
  validate: (value: unknown) => T | undefined,
): T | Unread {
  const entry = cache.get(key);
  if (entry !== undefined) {
    return entry.state === 'ready' ? (entry.value as T) : entry.state;
  }
  if (call === undefined) {
    return 'failed';
  }
  const settle = (value: unknown): void => {
    const valid = validate(value);
    cache.set(
      key,
      valid === undefined
        ? { state: 'failed' }
        : { state: 'ready', value: valid },
    );
  };
  let result: unknown;
  try {
    result = call();
  } catch {
    cache.set(key, { state: 'failed' });
    return 'failed';
  }
  if (isThenable(result)) {
    const promise = Promise.resolve(result).then(settle, () => {
      cache.set(key, { state: 'failed' });
    });
    cache.set(key, { state: 'pending', promise });
    return 'pending';
  }
  settle(result);
  const settled = cache.get(key);
  return settled?.state === 'ready' ? (settled.value as T) : 'failed';
}

export function relationReader(
  source: RelationSource | undefined,
  cache: RelationCache,
): RelationReader {
  return {
    chain(query) {
      return read(
        cache,
        JSON.stringify(['chain', query.resource, query.id, query.depth]),
        source === undefined
          ? undefined
          : () => source.ancestors({ ...query, through: 'parent' }),
        asChain,
      );
    },
    holders(query) {
      return read(
        cache,
        JSON.stringify(['holders', query.resource, query.id, query.relation]),
        source === undefined ? undefined : () => source.related({ ...query }),
        asHolders,
      );
    },
  };
}

/** The loads still in flight, for an instance that awaits them before deciding. */
export function pendingRelations(
  cache: RelationCache,
): readonly Promise<void>[] {
  const out: Promise<void>[] = [];
  for (const entry of cache.values()) {
    if (entry.state === 'pending') {
      out.push(entry.promise);
    }
  }
  return out;
}

export function relationId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

export function holdsNow(
  holder: RelationHolder,
  principalId: string,
  now: number,
): boolean {
  return (
    holder.principal.id === principalId &&
    (holder.startsAt === undefined || holder.startsAt <= now) &&
    (holder.expiresAt === undefined || holder.expiresAt > now)
  );
}

/** The instances a graph relation reads: the start, then ancestors until a restricted one or `depth`. */
export function relationWalk(
  condition: RelatedCondition,
  row: unknown,
  reader: RelationReader,
):
  | {
      readonly ids: readonly string[];
      readonly truncated: boolean;
    }
  | 'relation-depth'
  | 'relation-unavailable'
  | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const id = relationId(ownGet(row, condition.field));
  if (id === undefined) {
    return undefined;
  }
  const rowRestricted =
    condition.restricted !== undefined &&
    ownGet(row, condition.restricted) === true;
  if (condition.parent === true && rowRestricted) {
    return undefined;
  }
  if (condition.depth === 0 || rowRestricted) {
    return { ids: [id], truncated: false };
  }
  const chain = reader.chain({
    resource: condition.resource,
    id,
    depth: condition.depth,
  });
  if (chain === 'pending' || chain === 'failed') {
    return 'relation-unavailable';
  }
  const ids = [id];
  let stopped = chain.restricted === true;
  if (!stopped) {
    for (const ancestor of chain.ancestors.slice(0, condition.depth)) {
      ids.push(ancestor.id);
      if (ancestor.restricted === true) {
        stopped = true;
        break;
      }
    }
  }
  if (new Set(ids).size !== ids.length) {
    return 'relation-depth';
  }
  return {
    ids,
    truncated:
      !stopped &&
      (chain.ancestors.length > condition.depth || chain.truncated === true),
  };
}

/**
 * Whether the subject holds the relation on the row's instance or an
 * ancestor within `depth`. A cycle is `relation-depth`; so is a chain that
 * goes on past `depth` with no holder below it. Any read the instance could
 * not answer is `relation-unavailable` unless a holder was found elsewhere.
 */
export function resolveRelated(
  condition: RelatedCondition,
  row: unknown,
  subject: Subject,
  now: number,
  reader: RelationReader,
): RelatedVerdict {
  const principal = subject.principal;
  if (principal === null) {
    return false;
  }
  const walk = relationWalk(condition, row, reader);
  if (walk === undefined) {
    return false;
  }
  if (walk === 'relation-depth' || walk === 'relation-unavailable') {
    return walk;
  }
  let unavailable = false;
  for (const id of walk.ids) {
    const holders = reader.holders({
      resource: condition.resource,
      id,
      relation: condition.relation,
    });
    if (holders === 'pending' || holders === 'failed') {
      unavailable = true;
      continue;
    }
    if (holders.some((holder) => holdsNow(holder, principal.id, now))) {
      return true;
    }
  }
  if (unavailable) {
    return 'relation-unavailable';
  }
  return walk.truncated ? 'relation-depth' : false;
}

export type MemoryEdge = {
  /** The object's id. */
  readonly id: string;
  readonly principal: string;
  readonly startsAt?: number;
  readonly expiresAt?: number;
};

export type MemoryRelationsData = {
  /** Rows per resource: parent pointers, restricted flags and relation columns are read from them. */
  readonly rows?: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  /** Edge-table rows per resource and relation. */
  readonly edges?: Readonly<
    Record<string, Readonly<Record<string, readonly MemoryEdge[]>>>
  >;
};

function seconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time / 1000;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
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
  } = {
    principal: { id: edge.principal },
  };
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
export function memoryRelations(
  permissions: PermissionTree,
  data: MemoryRelationsData = {},
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
      const id = relationId(ownGet(row, node?.id ?? 'id'));
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
    ancestors({ resource, id, depth }) {
      const node = registry.get(resource);
      const start = rowOf(resource, id);
      if (node === undefined || start === undefined) {
        return { ancestors: [] };
      }
      const restricted = restrictedOf(node, start);
      if (
        restricted ||
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
        if (seen.has(next) || hidden) {
          next = undefined;
          break;
        }
        seen.add(next);
        next = relationId(ownGet(row, field));
      }
      return next === undefined
        ? { ancestors }
        : { ancestors, truncated: true };
    },
    related({ resource, id, relation }) {
      const spec = registry.get(resource)?.relations[relation];
      if (spec === undefined) {
        return [];
      }
      if (isEdgeRelation(spec)) {
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
