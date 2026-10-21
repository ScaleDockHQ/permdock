import type {
  RelationChain,
  RelationGroup,
  RelationHolder,
  RelationSource,
} from "./interfaces.ts";
import type { ResourceNode } from "./permission-types.ts";

import { isRecord } from "./compact.ts";
import { idText } from "./ids.ts";
import { expandRelation } from "./resource-relations.ts";
import { isThenable } from "./thenable.ts";

/**
 * How deep groups of one resource may nest in each other; a group of another
 * resource starts a fresh count.
 */
export const DEFAULT_GROUP_DEPTH = 16;

/**
 * A holder as the reader returns it: tagged with the relation it was read
 * under, after `includes`.
 */
export type ReadHolder = RelationHolder & { readonly relation: string };

type CacheEntry =
  | { readonly state: "ready"; readonly value: unknown }
  | { readonly state: "pending"; readonly promise: Promise<void> }
  | { readonly state: "failed" };

/**
 * One instance's relation facts, keyed by query. Lives on the instance, never
 * at module level.
 */
export type RelationCache = Map<string, CacheEntry>;

export type Unread = "pending" | "failed";

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
  row(query: {
    readonly resource: string;
    readonly id: string;
  }): { readonly row: Readonly<Record<string, unknown>> | null } | Unread;
  /** Holders of `relation` and of every relation it includes. */
  holders(query: {
    readonly resource: string;
    readonly id: string;
    readonly relation: string;
  }): readonly ReadHolder[] | Unread;
};

export type RelatedVerdict =
  | boolean
  | "relation-depth"
  | "relation-unavailable";

function isInstant(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function asChain(value: unknown): RelationChain | undefined {
  if (!isRecord(value) || !Array.isArray(value["ancestors"])) {
    return undefined;
  }
  const ancestors: { readonly id: string; readonly restricted?: boolean }[] =
    [];
  // SAFETY: a widening from any, so each ancestor is checked with isRecord below.
  for (const item of value["ancestors"] as readonly unknown[]) {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      item["id"] === ""
    ) {
      return undefined;
    }
    ancestors.push(
      item["restricted"] === true
        ? { id: item["id"], restricted: true }
        : { id: item["id"] },
    );
  }
  return {
    ancestors,
    ...(value["restricted"] === true ? { restricted: true } : {}),
    ...(value["truncated"] === true ? { truncated: true } : {}),
  };
}

function asRow(
  value: unknown,
): { readonly row: Readonly<Record<string, unknown>> | null } | undefined {
  if (value === null || value === undefined) {
    return { row: null };
  }
  return isRecord(value) ? { row: value } : undefined;
}

function asGroup(value: unknown): RelationGroup | undefined {
  if (
    !isRecord(value) ||
    typeof value["resource"] !== "string" ||
    typeof value["id"] !== "string" ||
    typeof value["relation"] !== "string" ||
    value["id"] === ""
  ) {
    return undefined;
  }
  return {
    resource: value["resource"],
    id: value["id"],
    relation: value["relation"],
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
      !isInstant(item["startsAt"]) ||
      !isInstant(item["expiresAt"])
    ) {
      return undefined;
    }
    const period = {
      ...(item["startsAt"] === undefined ? {} : { startsAt: item["startsAt"] }),
      ...(item["expiresAt"] === undefined
        ? {}
        : { expiresAt: item["expiresAt"] }),
    };
    if (
      isRecord(item["principal"]) &&
      typeof item["principal"]["id"] === "string"
    ) {
      holders.push({ principal: { id: item["principal"]["id"] }, ...period });
      continue;
    }
    const group = asGroup(item["group"]);
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
    return entry.state === "ready" ? (entry.value as T) : entry.state;
  }
  if (call === undefined) {
    return "failed";
  }
  const settle = (value: unknown): void => {
    const valid = validate(value);
    cache.set(
      key,
      valid === undefined
        ? { state: "failed" }
        : { state: "ready", value: valid },
    );
  };
  let result: unknown;
  try {
    result = call();
  } catch {
    cache.set(key, { state: "failed" });
    return "failed";
  }
  if (isThenable(result)) {
    const promise = Promise.resolve(result).then(settle, () => {
      cache.set(key, { state: "failed" });
    });
    cache.set(key, { state: "pending", promise });
    return "pending";
  }
  settle(result);
  const settled = cache.get(key);
  // SAFETY: settle above stored validate's result for this key.
  return settled?.state === "ready" ? (settled.value as T) : "failed";
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
      JSON.stringify(["holders", resource, id, relation]),
      source === undefined
        ? undefined
        : () => source.related({ resource, id, relation }),
      asHolders,
    );
  return {
    available: source !== undefined,
    row(query) {
      const load = source?.row?.bind(source);
      return read(
        cache,
        JSON.stringify(["row", query.resource, query.id]),
        load === undefined
          ? undefined
          : () => load({ resource: query.resource, id: query.id }),
        asRow,
      );
    },
    chain(query) {
      const through = query.through ?? "parent";
      return read(
        cache,
        JSON.stringify([
          "chain",
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
        if (answer === "pending" || answer === "failed") {
          unread =
            answer === "failed" || unread === "failed" ? "failed" : "pending";
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
    if (entry.state === "pending") {
      out.push(entry.promise);
    }
  }
  return out;
}

export function relationId(value: unknown): string | undefined {
  return idText(value);
}
