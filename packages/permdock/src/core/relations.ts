import type { RelatedCondition } from '../conditions/ast.ts';
import type {
  RelationChain,
  RelationGroup,
  RelationHolder,
  RelationSource,
} from './interfaces.ts';
import type {
  EdgeRelation,
  PermissionTree,
  ResourceNode,
} from './permissions.ts';
import type { Subject } from './subject.ts';

import { ownGet } from './paths.ts';
import {
  expandRelation,
  getRegistry,
  isComputedRelation,
  isEdgeRelation,
  isPrincipalRelation,
} from './permissions.ts';
import { isThenable } from './thenable.ts';

/** How deep groups of one resource may nest in each other; a group of another resource starts a fresh count. */
export const DEFAULT_GROUP_DEPTH = 16;

/** A holder as the reader returns it: tagged with the relation it was read under, after `includes`. */
export type ReadHolder = RelationHolder & { readonly relation: string };

type CacheEntry =
  | { readonly state: 'ready'; readonly value: unknown }
  | { readonly state: 'pending'; readonly promise: Promise<void> }
  | { readonly state: 'failed' };

/** One instance's relation facts, keyed by query. Lives on the instance, never at module level. */
export type RelationCache = Map<string, CacheEntry>;

export type Unread = 'pending' | 'failed';

/** Synchronous reads over a `RelationSource` and the instance's cache. */
export type RelationReader = {
  /** Whether a `RelationSource` was configured at all. */
  readonly available: boolean;
  chain(query: {
    readonly resource: string;
    readonly id: string;
    readonly depth: number;
    /** `'parent'` (the default) or a link name. */
    readonly through?: string;
  }): RelationChain | Unread;
  /** Holders of `relation` and of every relation it includes. */
  holders(query: {
    readonly resource: string;
    readonly id: string;
    readonly relation: string;
  }): readonly ReadHolder[] | Unread;
};

export type RelatedVerdict =
  | boolean
  | 'relation-depth'
  | 'relation-unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInstant(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === 'number' && Number.isFinite(value))
  );
}

function asChain(value: unknown): RelationChain | undefined {
  if (!isRecord(value) || !Array.isArray(value['ancestors'])) {
    return undefined;
  }
  const ancestors: { readonly id: string; readonly restricted?: boolean }[] =
    [];
  // SAFETY: a widening from any, so each ancestor is checked with isRecord below.
  for (const item of value['ancestors'] as readonly unknown[]) {
    if (
      !isRecord(item) ||
      typeof item['id'] !== 'string' ||
      item['id'] === ''
    ) {
      return undefined;
    }
    ancestors.push(
      item['restricted'] === true
        ? { id: item['id'], restricted: true }
        : { id: item['id'] },
    );
  }
  return {
    ancestors,
    ...(value['restricted'] === true ? { restricted: true } : {}),
    ...(value['truncated'] === true ? { truncated: true } : {}),
  };
}

function asGroup(value: unknown): RelationGroup | undefined {
  if (
    !isRecord(value) ||
    typeof value['resource'] !== 'string' ||
    typeof value['id'] !== 'string' ||
    typeof value['relation'] !== 'string' ||
    value['id'] === ''
  ) {
    return undefined;
  }
  return {
    resource: value['resource'],
    id: value['id'],
    relation: value['relation'],
  };
}

function asHolders(value: unknown): readonly RelationHolder[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const holders: RelationHolder[] = [];
  // SAFETY: a widening from any, so each holder is checked with isRecord below.
  for (const item of value as readonly unknown[]) {
    if (
      !isRecord(item) ||
      !isInstant(item['startsAt']) ||
      !isInstant(item['expiresAt'])
    ) {
      return undefined;
    }
    const period = {
      ...(item['startsAt'] === undefined ? {} : { startsAt: item['startsAt'] }),
      ...(item['expiresAt'] === undefined
        ? {}
        : { expiresAt: item['expiresAt'] }),
    };
    if (
      isRecord(item['principal']) &&
      typeof item['principal']['id'] === 'string'
    ) {
      holders.push({ principal: { id: item['principal']['id'] }, ...period });
      continue;
    }
    const group = asGroup(item['group']);
    if (group === undefined) {
      return undefined;
    }
    holders.push({ group, ...period });
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
    // SAFETY: a ready entry holds the result of validate, and each key is read with one validator.
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
  // SAFETY: settle above stored validate's result for this key.
  return settled?.state === 'ready' ? (settled.value as T) : 'failed';
}

export function relationReader(
  source: RelationSource | undefined,
  cache: RelationCache,
  resources?: ReadonlyMap<string, ResourceNode>,
): RelationReader {
  const concrete = (
    resource: string,
    id: string,
    relation: string,
  ): readonly RelationHolder[] | Unread =>
    read(
      cache,
      JSON.stringify(['holders', resource, id, relation]),
      source === undefined
        ? undefined
        : () => source.related({ resource, id, relation }),
      asHolders,
    );
  return {
    available: source !== undefined,
    chain(query) {
      const through = query.through ?? 'parent';
      return read(
        cache,
        JSON.stringify([
          'chain',
          query.resource,
          query.id,
          query.depth,
          through,
        ]),
        source === undefined
          ? undefined
          : () =>
              source.ancestors({
                resource: query.resource,
                id: query.id,
                depth: query.depth,
                through,
              }),
        asChain,
      );
    },
    holders(query) {
      const node = resources?.get(query.resource);
      const names =
        node === undefined
          ? [query.relation]
          : expandRelation(node, query.relation);
      const out: ReadHolder[] = [];
      let unread: Unread | undefined;
      for (const name of names) {
        const answer = concrete(query.resource, query.id, name);
        if (answer === 'pending' || answer === 'failed') {
          unread =
            answer === 'failed' || unread === 'failed' ? 'failed' : 'pending';
          continue;
        }
        for (const holder of answer) {
          out.push({ ...holder, relation: name });
        }
      }
      return unread ?? out;
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

/** Whether the holder's period covers `now`. */
function activeNow(holder: RelationHolder, now: number): boolean {
  return (
    (holder.startsAt === undefined || holder.startsAt <= now) &&
    (holder.expiresAt === undefined || holder.expiresAt > now)
  );
}

function holdsNow(
  holder: RelationHolder,
  principalId: string,
  now: number,
): boolean {
  return (
    'principal' in holder &&
    holder.principal.id === principalId &&
    activeNow(holder, now)
  );
}

/** Where the walk starts after following `hops`, or why it cannot. */
function followHops(
  condition: RelatedCondition,
  first: string,
  reader: RelationReader,
): { readonly id: string } | 'relation-unavailable' | undefined {
  const hops = condition.hops ?? [];
  let id = first;
  for (let index = 1; index < hops.length; index += 1) {
    const from = hops[index - 1];
    const hop = hops[index];
    if (from === undefined || hop === undefined) {
      /* v8 ignore next */
      return undefined;
    }
    const chain = reader.chain({
      resource: from.resource,
      id,
      depth: 1,
      through: hop.link,
    });
    if (chain === 'pending' || chain === 'failed') {
      return 'relation-unavailable';
    }
    const next = chain.ancestors[0]?.id;
    if (next === undefined) {
      return undefined;
    }
    id = next;
  }
  return { id };
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
  const first = relationId(ownGet(row, condition.field));
  if (first === undefined) {
    return undefined;
  }
  const rowRestricted =
    condition.restricted !== undefined &&
    ownGet(row, condition.restricted) === true;
  const hopped = condition.hops !== undefined && condition.hops.length > 0;
  if ((condition.parent === true || hopped) && rowRestricted) {
    return undefined;
  }
  const start = hopped ? followHops(condition, first, reader) : { id: first };
  if (start === undefined || start === 'relation-unavailable') {
    return start;
  }
  const id = start.id;
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
  if (condition.ids !== undefined) {
    const held = new Set(condition.ids);
    if (walk.ids.some((id) => held.has(id))) {
      return true;
    }
    return walk.truncated ? 'relation-depth' : false;
  }
  let unavailable = false;
  let deep = false;
  for (const id of walk.ids) {
    const verdict = holdsRelation(
      {
        resource: condition.resource,
        id,
        relation: condition.relation,
      },
      principal.id,
      now,
      reader,
      DEFAULT_GROUP_DEPTH,
      new Set(),
    );
    if (verdict === true) {
      return true;
    }
    if (verdict === 'relation-unavailable') {
      unavailable = true;
    } else if (verdict === 'relation-depth') {
      deep = true;
    }
  }
  if (unavailable) {
    return 'relation-unavailable';
  }
  return walk.truncated || deep ? 'relation-depth' : false;
}

function groupKey(group: RelationGroup): string {
  return JSON.stringify([group.resource, group.id, group.relation]);
}

/**
 * Whether the principal holds `at.relation` on one instance, directly or
 * through a group whose members hold it. Groups of `at`'s own resource nest
 * at most `budget` deep; a group of another resource gets a fresh budget
 * (declarations rule out cycles across resources). A group met twice on one
 * path, or one past the budget, is `relation-depth`.
 */
function holdsRelation(
  at: RelationGroup,
  principalId: string,
  now: number,
  reader: RelationReader,
  budget: number,
  seen: ReadonlySet<string>,
): RelatedVerdict {
  const holders = reader.holders(at);
  if (holders === 'pending' || holders === 'failed') {
    return 'relation-unavailable';
  }
  if (holders.some((holder) => holdsNow(holder, principalId, now))) {
    return true;
  }
  const path = new Set(seen).add(groupKey(at));
  let unavailable = false;
  let deep = false;
  for (const holder of holders) {
    if (!('group' in holder) || !activeNow(holder, now)) {
      continue;
    }
    const nested = holder.group.resource === at.resource;
    if ((nested && budget <= 0) || path.has(groupKey(holder.group))) {
      deep = true;
      continue;
    }
    const verdict = holdsRelation(
      holder.group,
      principalId,
      now,
      reader,
      nested ? budget - 1 : DEFAULT_GROUP_DEPTH,
      path,
    );
    if (verdict === true) {
      return true;
    }
    if (verdict === 'relation-unavailable') {
      unavailable = true;
    } else if (verdict === 'relation-depth') {
      deep = true;
    }
  }
  if (unavailable) {
    return 'relation-unavailable';
  }
  return deep ? 'relation-depth' : false;
}

export type MemoryEdge = {
  /** The object's id. */
  readonly id: string;
  readonly principal: string;
  readonly startsAt?: number;
  readonly expiresAt?: number;
};

export type MemoryRelationsData = {
  /** Rows per resource: parent pointers, links, restricted flags and relation columns are read from them. */
  readonly rows?: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  /** Edge-table rows per resource and relation. */
  readonly edges?: Readonly<
    Record<string, Readonly<Record<string, readonly MemoryEdge[]>>>
  >;
  /**
   * Edge tables as the database holds them, keyed by `edge` name: each row
   * is read through the relation's `object`, `subject`, `expiresAt`, `match`
   * and `groups` columns. A relation whose table is here ignores `edges`.
   */
  readonly tables?: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
};

/** The holder one edge-table row names for `spec`, or `undefined` when the row does not belong to it. */
function tableHolder(
  resourceName: string,
  spec: EdgeRelation,
  row: Readonly<Record<string, unknown>>,
  id: string,
): RelationHolder | undefined {
  if (relationId(ownGet(row, spec.object ?? `${resourceName}_id`)) !== id) {
    return undefined;
  }
  for (const [column, value] of Object.entries(spec.match ?? {})) {
    if (ownGet(row, column) !== value) {
      return undefined;
    }
  }
  const subject = relationId(ownGet(row, spec.subject ?? 'user_id'));
  if (subject === undefined) {
    return undefined;
  }
  const expiresAt =
    spec.expiresAt === undefined
      ? undefined
      : seconds(ownGet(row, spec.expiresAt));
  const period = expiresAt === undefined ? {} : { expiresAt };
  const groups = spec.groups;
  const kind = groups === undefined ? null : ownGet(row, groups.column);
  if (
    groups === undefined ||
    kind === null ||
    kind === undefined ||
    kind === groups.direct
  ) {
    return { principal: { id: subject }, ...period };
  }
  const relation =
    typeof kind === 'string' && Object.hasOwn(groups.resources, kind)
      ? groups.resources[kind]
      : undefined;
  // SAFETY: relation is defined only when kind passed the typeof string check above.
  return relation === undefined
    ? undefined
    : { group: { resource: kind as string, id: subject, relation }, ...period };
}

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
    ancestors({ resource, id, depth, through }) {
      const node = registry.get(resource);
      const start = rowOf(resource, id);
      if (node === undefined || start === undefined) {
        return { ancestors: [] };
      }
      if (through !== 'parent') {
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
      if (spec === undefined || isComputedRelation(spec)) {
        return [];
      }
      if (isEdgeRelation(spec)) {
        const table = data.tables?.[spec.edge];
        if (table !== undefined) {
          return table.flatMap((row) => {
            const holder = tableHolder(resource, spec, row, id);
            return holder === undefined ? [] : [holder];
          });
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
