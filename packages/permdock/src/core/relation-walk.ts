import type { RelatedCondition } from "../conditions/ast.ts";
import type { RelationGroup, RelationHolder } from "./interfaces.ts";
import type { RelatedVerdict, RelationReader } from "./relations.ts";
import type { Subject } from "./subject.ts";

import { isRecord } from "./compact.ts";
import { ownGet } from "./paths.ts";
import { DEFAULT_GROUP_DEPTH, relationId } from "./relations.ts";

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
    "principal" in holder &&
    holder.principal.id === principalId &&
    activeNow(holder, now)
  );
}

/** Where the walk starts after following `hops`, or why it cannot. */
function followHops(
  condition: RelatedCondition,
  first: string,
  reader: RelationReader,
): { readonly id: string } | "relation-unavailable" | undefined {
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
    if (chain === "pending" || chain === "failed") {
      return "relation-unavailable";
    }
    const next = chain.ancestors[0]?.id;
    if (next === undefined) {
      return undefined;
    }
    id = next;
  }
  return { id };
}

function restrictedAbove(
  condition: RelatedCondition,
  row: Readonly<Record<string, unknown>>,
  reader: RelationReader,
): undefined | "relation-depth" | "relation-unavailable" | false {
  const above = condition.restrictedAncestors;
  if (above === undefined) {
    return false;
  }
  const parent = relationId(ownGet(row, above.parent));
  if (parent === undefined) {
    return false;
  }
  const chain = reader.chain({
    resource: above.resource,
    id: parent,
    depth: above.depth - 1,
  });
  if (chain === "pending" || chain === "failed") {
    return "relation-unavailable";
  }
  if (
    chain.restricted === true ||
    chain.ancestors.some((ancestor) => ancestor.restricted === true)
  ) {
    return undefined;
  }
  const own = relationId(ownGet(row, above.id));
  const ids = [
    ...(own === undefined ? [] : [own]),
    parent,
    ...chain.ancestors.map((ancestor) => ancestor.id),
  ];
  if (
    new Set(ids).size !== ids.length ||
    chain.truncated === true ||
    chain.ancestors.length > above.depth - 1
  ) {
    return "relation-depth";
  }
  return false;
}

/**
 * The instances a graph relation reads: the start, then ancestors until a
 * restricted one or `depth`.
 */
export function relationWalk(
  condition: RelatedCondition,
  row: unknown,
  reader: RelationReader,
):
  | { readonly ids: readonly string[]; readonly truncated: boolean }
  | "relation-depth"
  | "relation-unavailable"
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
  const above = restrictedAbove(condition, row, reader);
  if (above !== false) {
    return above;
  }
  const start = hopped ? followHops(condition, first, reader) : { id: first };
  if (start === undefined || start === "relation-unavailable") {
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
  if (chain === "pending" || chain === "failed") {
    return "relation-unavailable";
  }
  const ids = [id];
  const stops = condition.passRestricted !== true;
  let stopped = stops && chain.restricted === true;
  if (!stopped) {
    for (const ancestor of chain.ancestors.slice(0, condition.depth)) {
      ids.push(ancestor.id);
      if (stops && ancestor.restricted === true) {
        stopped = true;
        break;
      }
    }
  }
  if (new Set(ids).size !== ids.length) {
    return "relation-depth";
  }
  return {
    ids,
    truncated:
      !stopped &&
      (chain.ancestors.length > condition.depth || chain.truncated === true),
  };
}

/**
 * Whether the subject holds the relation on the row's instance or an ancestor
 * within `depth`. A cycle is `relation-depth`; so is a chain that goes on past
 * `depth` with no holder below it. Any read the instance could not answer is
 * `relation-unavailable` unless a holder was found elsewhere.
 */
export function resolveRelated(
  condition: RelatedCondition,
  row: unknown,
  subject: Subject,
  now: number,
  reader: RelationReader,
  permitted?: (
    resource: string,
    id: string,
    permission: string,
  ) => RelatedVerdict,
): RelatedVerdict {
  if (condition.permission !== undefined) {
    return resolveInherited(
      condition,
      condition.permission,
      row,
      reader,
      permitted,
    );
  }
  const principal = subject.principal;
  if (principal === null) {
    return false;
  }
  const walk = relationWalk(condition, row, reader);
  if (walk === undefined) {
    return false;
  }
  if (walk === "relation-depth" || walk === "relation-unavailable") {
    return walk;
  }
  if (condition.ids !== undefined) {
    const held = new Set(condition.ids);
    if (walk.ids.some((id) => held.has(id))) {
      return true;
    }
    return walk.truncated ? "relation-depth" : false;
  }
  let unavailable = false;
  let deep = false;
  const explored = new Map<string, number>();
  for (const id of walk.ids) {
    const verdict = holdsRelation(
      { resource: condition.resource, id, relation: condition.relation },
      principal.id,
      now,
      reader,
      DEFAULT_GROUP_DEPTH,
      new Set(),
      explored,
    );
    if (verdict === true) {
      return true;
    }
    if (verdict === "relation-unavailable") {
      unavailable = true;
    } else if (verdict === "relation-depth") {
      deep = true;
    }
  }
  if (unavailable) {
    return "relation-unavailable";
  }
  return walk.truncated || deep ? "relation-depth" : false;
}

function resolveInherited(
  condition: RelatedCondition,
  permission: string,
  row: unknown,
  reader: RelationReader,
  permitted:
    | ((resource: string, id: string, permission: string) => RelatedVerdict)
    | undefined,
): RelatedVerdict {
  const walk = relationWalk(condition, row, reader);
  if (walk === undefined) {
    return false;
  }
  if (walk === "relation-depth" || walk === "relation-unavailable") {
    return walk;
  }
  if (permitted === undefined) {
    return "relation-unavailable";
  }
  let unknown: RelatedVerdict = false;
  for (const id of walk.ids) {
    const verdict = permitted(condition.resource, id, permission);
    if (verdict === true) {
      return true;
    }
    if (verdict !== false && unknown === false) {
      unknown = verdict;
    }
  }
  return unknown;
}

function groupKey(group: RelationGroup): string {
  return JSON.stringify([group.resource, group.id, group.relation]);
}

/**
 * Whether the principal holds `at.relation` on one instance, directly or
 * through a group whose members hold it. Groups of `at`'s own resource nest at
 * most `budget` deep; a group of another resource gets a fresh budget
 * (declarations rule out cycles across resources). A group met twice on one
 * path, or one past the budget, is `relation-depth`. `explored` holds the
 * budget each group was walked with across the whole walk: a group already
 * walked with as much budget adds nothing, since its verdict already reached
 * the caller, so shared sub-groups cost one walk rather than one per path.
 */
function holdsRelation(
  at: RelationGroup,
  principalId: string,
  now: number,
  reader: RelationReader,
  budget: number,
  seen: ReadonlySet<string>,
  explored: Map<string, number>,
): RelatedVerdict {
  const key = groupKey(at);
  const walked = explored.get(key);
  if (walked !== undefined && walked >= budget) {
    return false;
  }
  explored.set(key, budget);
  const holders = reader.holders(at);
  if (holders === "pending" || holders === "failed") {
    return "relation-unavailable";
  }
  if (holders.some((holder) => holdsNow(holder, principalId, now))) {
    return true;
  }
  const path = new Set(seen).add(key);
  let unavailable = false;
  let deep = false;
  for (const holder of holders) {
    if (!("group" in holder) || !activeNow(holder, now)) {
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
      explored,
    );
    if (verdict === true) {
      return true;
    }
    if (verdict === "relation-unavailable") {
      unavailable = true;
    } else if (verdict === "relation-depth") {
      deep = true;
    }
  }
  if (unavailable) {
    return "relation-unavailable";
  }
  return deep ? "relation-depth" : false;
}
