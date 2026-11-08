import type { Snapshot, SnapshotTenants } from "../core/snapshot-types.ts";

type Included = readonly (
  | { readonly key: string }
  | { readonly [key: string]: unknown }
)[];

/** What decides the bytes of a snapshot: two equal keys build one snapshot. */
export type SnapshotKeyInput = {
  readonly tenant?: string | undefined;
  readonly version?: number | undefined;
  readonly include?: Included | undefined;
  readonly tenants?: SnapshotTenants | undefined;
  readonly omitAssignable?: boolean | undefined;
  readonly context?: readonly string[] | undefined;
};

type Built = Promise<Snapshot | string>;

/**
 * The snapshots one request has produced. `create` is meant to run inside
 * `React.cache`, so the registry lives and dies with the request.
 */
export type SnapshotRegistry = {
  /** The same promise for equal inputs, so Flight writes it once. */
  readonly memo: (input: SnapshotKeyInput, build: () => Built) => Built;
  /**
   * Development only: calls `onDuplicate(bytes)` when two different promises of
   * this request resolve to equal snapshots. A no-op elsewhere.
   */
  readonly watch: (promise: Built) => void;
};

function isKeyed(item: object): item is { readonly key: string } {
  return "key" in item && typeof item.key === "string";
}

type ObjectIds = { readonly map: WeakMap<object, number>; next: number };

/**
 * A stable string for the inputs. Permission leaves are identified by `key`;
 * any other `include` entry by the order the request first saw it.
 */
function keyOf(input: SnapshotKeyInput, ids: ObjectIds): string {
  const include = input.include?.map((item) => {
    if (isKeyed(item)) {
      return `k:${item.key}`;
    }
    const known = ids.map.get(item) ?? ids.next;
    if (!ids.map.has(item)) {
      ids.map.set(item, known);
      ids.next += 1;
    }
    return `o:${String(known)}`;
  });
  return JSON.stringify([
    input.tenant ?? null,
    input.version ?? null,
    include ?? null,
    input.tenants ?? null,
    input.omitAssignable ?? false,
    input.context ?? null,
  ]);
}

export function createSnapshotRegistry(
  development: boolean,
  onDuplicate: (bytes: number) => void,
): SnapshotRegistry {
  const built = new Map<string, Built>();
  const ids: ObjectIds = { map: new WeakMap(), next: 0 };
  const watched = new WeakSet<object>();
  const texts = new Set<string>();
  return {
    memo(input, build) {
      const key = keyOf(input, ids);
      const known = built.get(key);
      if (known !== undefined) {
        return known;
      }
      const fresh = build();
      built.set(key, fresh);
      return fresh;
    },
    watch(promise) {
      if (!development || watched.has(promise)) {
        return;
      }
      watched.add(promise);
      promise.then(
        (value) => {
          const text =
            typeof value === "string" ? value : JSON.stringify(value);
          if (texts.has(text)) {
            onDuplicate(text.length);
          }
          texts.add(text);
        },
        () => undefined,
      );
    },
  };
}
