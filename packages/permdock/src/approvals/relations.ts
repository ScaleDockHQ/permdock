import type { RelatedCondition } from "../conditions/ast.ts";
import type { RelationGrantee } from "../core/grantee.ts";
import type { RelationSource } from "../core/interfaces.ts";
import type { PermissionTree, ResourceNode } from "../core/permissions.ts";
import type { Subject } from "../core/subject.ts";
import type { ApprovalRequest } from "./types.ts";

import { flattenApprovers } from "../core/approvers.ts";
import { getRegistry } from "../core/permissions.ts";
import {
  type RelationCache,
  type RelationReader,
  pendingRelations,
  relationReader,
  resolveRelated,
} from "../core/relations.ts";
import { approverRelationKey } from "./types.ts";

export type ApproverRelationsOptions = {
  /** The object graph relation approvers are read from; without it they match nobody. */
  readonly relations?: RelationSource;
  /** The permission tree the policy declares; needed to follow `through` links and `includes`. */
  readonly permissions?: PermissionTree;
  readonly now?: Date;
};

const DEFAULT_PARENT_DEPTH = 16;

/** Reads until nothing is in flight: each round loads one more layer of facts. */
async function settled<T>(
  read: () => T,
  unread: (value: T) => boolean,
  cache: RelationCache,
): Promise<T> {
  for (;;) {
    const value = read();
    if (!unread(value)) {
      return value;
    }
    const pending = pendingRelations(cache);
    if (pending.length === 0) {
      return value;
    }
    // oxlint-disable-next-line no-await-in-loop -- each round's reads depend on the facts the previous round loaded
    await Promise.all(pending);
  }
}

/** The id of `item.resource` the walk starts from, after following `through` links. */
async function startOf(
  item: RelationGrantee,
  resource: string,
  id: string,
  reader: RelationReader,
  cache: RelationCache,
  registry: ReadonlyMap<string, ResourceNode>,
): Promise<string | undefined> {
  if (!Array.isArray(item.through)) {
    return resource === item.resource ? id : undefined;
  }
  let current = resource;
  let at = id;
  // SAFETY: Array.isArray does not narrow a readonly array; through is a link list here.
  for (const link of item.through as readonly string[]) {
    const node = registry.get(current);
    const target =
      node !== undefined && Object.hasOwn(node.links, link)
        ? node.links[link]
        : undefined;
    if (target === undefined) {
      return undefined;
    }
    const query = { resource: current, id: at, depth: 1, through: link };
    // oxlint-disable-next-line no-await-in-loop -- each link starts from the instance the previous one reached
    const chain = await settled(
      () => reader.chain(query),
      (value) => value === "pending",
      cache,
    );
    const next =
      chain === "pending" || chain === "failed"
        ? undefined
        : chain.ancestors[0]?.id;
    if (next === undefined) {
      return undefined;
    }
    current = target.resource;
    at = next;
  }
  return current === item.resource ? at : undefined;
}

function depthOf(item: RelationGrantee): number {
  if (item.through === "parent") {
    return item.depth ?? DEFAULT_PARENT_DEPTH;
  }
  return item.depth ?? 0;
}

/**
 * The relation approvers of `request` that `subject` holds on its resource,
 * keyed by `approverRelationKey`, for `ApprovalVerdict.relations`. Reads go
 * through `relations` by the request's resource id; a request without an id,
 * a missing source or a read that fails holds nothing.
 */
export async function approverRelations(
  request: ApprovalRequest,
  subject: Subject,
  options: ApproverRelationsOptions,
): Promise<readonly string[]> {
  const approvers = request.approvers;
  const id = request.resource.id;
  if (
    approvers === undefined ||
    id === undefined ||
    options.relations === undefined ||
    options.permissions === undefined ||
    subject.principal === null
  ) {
    return [];
  }
  const items = new Map<string, RelationGrantee>();
  for (const item of [
    ...flattenApprovers(approvers.by),
    ...(approvers.stages ?? []).flatMap((stage) => flattenApprovers(stage.by)),
    ...flattenApprovers(approvers.escalation?.to),
  ]) {
    if (item.kind === "relation") {
      items.set(approverRelationKey(item), item);
    }
  }
  if (items.size === 0) {
    return [];
  }
  const registry = getRegistry(options.permissions);
  const cache: RelationCache = new Map();
  const reader = relationReader(options.relations, cache, registry);
  const now = (options.now ?? new Date()).getTime() / 1000;
  const holds = async (item: RelationGrantee): Promise<boolean> => {
    const start = await startOf(
      item,
      request.resource.type,
      id,
      reader,
      cache,
      registry,
    );
    if (start === undefined) {
      return false;
    }
    const condition: RelatedCondition = {
      op: "related",
      resource: item.resource,
      relation: item.relation,
      field: "id",
      depth: depthOf(item),
    };
    const verdict = await settled(
      () => resolveRelated(condition, { id: start }, subject, now, reader),
      (value) => value === "relation-unavailable",
      cache,
    );
    return verdict === true;
  };
  const entries = [...items];
  const verdicts = await Promise.all(entries.map(([, item]) => holds(item)));
  return entries.flatMap(([key], index) =>
    verdicts[index] === true ? [key] : [],
  );
}
