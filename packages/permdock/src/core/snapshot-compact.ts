import type {
  Snapshot,
  ExpandedSnapshot,
  SnapshotGrant,
  SnapshotGrantTerms,
} from "./snapshot-types.ts";

import { canonicalJson } from "./canonical-json.ts";
import { isRecord } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";

/**
 * The wire form of an expanded snapshot: each distinct set of grant terms is
 * written once, in order of first use, so the same policy always serialises to
 * the same bytes.
 */
export function compactSnapshot(snapshot: ExpandedSnapshot): Snapshot {
  const { grants, ...rest } = snapshot;
  const indexes = new Map<string, number>();
  const conditions: SnapshotGrantTerms[] = [];
  const compacted: { permission: string; cond: number | number[] }[] = [];
  for (const { permission, ...terms } of grants) {
    const key = canonicalJson(terms);
    let cond = indexes.get(key);
    if (cond === undefined) {
      cond = conditions.length;
      indexes.set(key, cond);
      conditions.push(terms);
    }
    const last = compacted.at(-1);
    if (last?.permission !== permission) {
      compacted.push({ permission, cond });
    } else if (typeof last.cond === "number") {
      last.cond = [last.cond, cond];
    } else {
      last.cond.push(cond);
    }
  }
  return freezeDeep({ ...rest, conditions, grants: compacted });
}

function bad(detail: string): Error {
  return new Error(`PermDock: snapshot ${detail}`);
}

/**
 * The grants of a wire document as the `Snapshot` model holds them. Throws on a
 * `conditions` that is not a list of objects or a grant whose `cond` is not an
 * index into it, so a malformed document never reads as a narrower grant.
 */
export function expandGrants(record: Readonly<Record<string, unknown>>): {
  readonly grants: readonly SnapshotGrant[];
} {
  const conditions = record["conditions"];
  const grants = record["grants"];
  if (!Array.isArray(conditions) || !conditions.every(isRecord)) {
    throw bad("conditions must be a list of objects");
  }
  if (!Array.isArray(grants)) {
    throw bad("grants must be a list");
  }
  return {
    grants: grants.flatMap((grant: unknown): SnapshotGrant[] => {
      if (!isRecord(grant) || typeof grant["permission"] !== "string") {
        throw bad("grants must name a permission");
      }
      const permission = grant["permission"];
      const cond = grant["cond"];
      const indexes: unknown[] = Array.isArray(cond) ? cond : [cond];
      if (indexes.length === 0) {
        throw bad(`grant '${permission}' has an empty cond list`);
      }
      return indexes.map((index): SnapshotGrant => {
        const terms =
          typeof index === "number" && Number.isInteger(index) && index >= 0
            ? conditions[index]
            : undefined;
        if (terms === undefined) {
          throw bad(
            `grant '${permission}' has a cond that is not an index into conditions`,
          );
        }
        // SAFETY: a condition entry holds the terms of a grant; the other fields are not validated here, as for v 1.
        return { permission, ...terms } as SnapshotGrant;
      });
    }),
  };
}

/** The flat form the evaluator reads, from a validated wire `Snapshot`. */
export function expandSnapshot(snapshot: Snapshot): ExpandedSnapshot {
  const { conditions: _conditions, grants: _grants, ...rest } = snapshot;
  return freezeDeep({ ...rest, ...expandGrants(snapshot) });
}
