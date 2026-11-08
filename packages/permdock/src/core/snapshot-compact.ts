import type {
  ClientBundle,
  Snapshot,
  ExpandedSnapshot,
  SnapshotGrant,
  SnapshotGrantTerms,
  SnapshotStatic,
} from "./snapshot-types.ts";

import { canonicalJson } from "./canonical-json.ts";
import { isRecord } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";

/**
 * Each distinct set of grant terms once, in order of first use, and the grants
 * as `{ permission, cond }` with runs of one permission merged.
 */
export function internGrants(grants: readonly SnapshotGrant[]): {
  readonly conditions: SnapshotGrantTerms[];
  readonly grants: { permission: string; cond: number | number[] }[];
} {
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
  return { conditions, grants: compacted };
}

/**
 * The wire form of an expanded snapshot: each distinct set of grant terms is
 * written once, in order of first use, so the same policy always serialises to
 * the same bytes. `held` names the role grants left to a `ClientBundle`.
 */
export function compactSnapshot(
  snapshot: ExpandedSnapshot,
  held?: SnapshotStatic,
): Snapshot {
  const { grants, ...rest } = snapshot;
  const interned = internGrants(grants);
  return freezeDeep({
    ...rest,
    conditions: interned.conditions,
    grants: interned.grants,
    ...(held === undefined ? {} : { static: held }),
  });
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

function bundleGrants(
  bundle: ClientBundle,
  role: string,
): readonly SnapshotGrant[] | undefined {
  const entry = Object.hasOwn(bundle.roles, role)
    ? bundle.roles[role]
    : undefined;
  return entry === undefined
    ? undefined
    : expandGrants({ conditions: bundle.conditions, grants: entry.grants })
        .grants;
}

/**
 * The grants `held` refers to, from `bundle`. A role the bundle lacks, or holds
 * under another digest, resolves to nothing, so a stale bundle denies.
 */
function staticGrants(
  snapshot: Snapshot,
  bundle: ClientBundle | undefined,
): readonly SnapshotGrant[] {
  const held = snapshot.static;
  if (held === undefined || bundle === undefined) {
    return [];
  }
  const memberships = snapshot.subject.principal?.memberships ?? [];
  return held.held.flatMap(([role, index]): SnapshotGrant[] => {
    const entry = Object.hasOwn(bundle.roles, role)
      ? bundle.roles[role]
      : undefined;
    const expected = Object.hasOwn(held.digests, role)
      ? held.digests[role]
      : undefined;
    if (entry === undefined || entry.digest !== expected) {
      return [];
    }
    const membership = index === null ? undefined : memberships[index];
    if (index !== null && membership === undefined) {
      return [];
    }
    return (bundleGrants(bundle, role) ?? []).map((grant): SnapshotGrant =>
      membership === undefined ? grant : { ...grant, membership },
    );
  });
}

/**
 * The flat form the evaluator reads, from a validated wire `Snapshot`. A
 * snapshot built with `omitStatic` needs the `bundle` its server generated;
 * grants it refers to are appended after the inline ones.
 */
export function expandSnapshot(
  snapshot: Snapshot,
  options: { readonly bundle?: ClientBundle | undefined } = {},
): ExpandedSnapshot {
  const {
    conditions: _conditions,
    grants: _grants,
    static: _static,
    ...rest
  } = snapshot;
  const inline = expandGrants(snapshot).grants;
  const held = staticGrants(snapshot, options.bundle);
  return freezeDeep({
    ...rest,
    grants: held.length === 0 ? inline : [...inline, ...held],
  });
}
