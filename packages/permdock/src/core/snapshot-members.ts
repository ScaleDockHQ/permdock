import type {
  SnapshotMembershipShape,
  SnapshotWireMembership,
} from "./snapshot-types.ts";
import type { Membership } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { compact, isRecord } from "./compact.ts";

const SHAPED: ReadonlySet<string> = new Set(["scope", "id", "roles", "via"]);

function shaped(
  membership: Membership,
): membership is Membership & { readonly scope: string; readonly id: string } {
  return (
    typeof membership.scope === "string" &&
    typeof membership.id === "string" &&
    Object.keys(membership).every((key) => SHAPED.has(key))
  );
}

/**
 * Memberships as the wire writes them: each distinct scope, roles and `via` is
 * a shape written once, and a membership with no other field is `[shape, id]`.
 */
export function wireMemberships(memberships: readonly Membership[]): {
  readonly shapes: readonly SnapshotMembershipShape[];
  readonly memberships: readonly SnapshotWireMembership[];
} {
  const shapes: SnapshotMembershipShape[] = [];
  const at = new Map<string, number>();
  const wire = memberships.map((membership): SnapshotWireMembership => {
    if (!shaped(membership)) {
      return membership;
    }
    const shape = compact<SnapshotMembershipShape>({
      scope: membership.scope,
      roles: membership.roles,
      via: membership.via,
    });
    const key = canonicalJson(shape);
    let index = at.get(key);
    if (index === undefined) {
      index = shapes.length;
      at.set(key, index);
      shapes.push(shape);
    }
    return [index, membership.id];
  });
  return { shapes, memberships: wire };
}

function bad(detail: string): Error {
  return new Error(`PermDock: snapshot ${detail}`);
}

/**
 * The memberships of a wire document. Throws on a `[shape, id]` whose shape is
 * not an index into `shapes`, so a malformed list never reads as other roles.
 */
export function readMemberships(
  wire: unknown,
  shapes: unknown,
): readonly Membership[] {
  if (wire === undefined) {
    return [];
  }
  const table = shapes ?? [];
  if (!Array.isArray(wire) || !Array.isArray(table)) {
    throw bad("memberships and shapes must be lists");
  }
  return wire.map((entry: unknown): Membership => {
    if (!Array.isArray(entry)) {
      if (!isRecord(entry)) {
        throw bad("has a membership that is neither an object nor a pair");
      }
      // SAFETY: an object membership is passed on as the v1 form did; the evaluator reads its fields defensively.
      return entry as Membership;
    }
    const pair: readonly unknown[] = entry;
    const index = pair[0];
    const id = pair[1];
    const shape: unknown =
      typeof index === "number" && Number.isInteger(index) && index >= 0
        ? table[index]
        : undefined;
    if (
      entry.length !== 2 ||
      typeof id !== "string" ||
      !isRecord(shape) ||
      typeof shape["scope"] !== "string" ||
      !Array.isArray(shape["roles"])
    ) {
      throw bad("has a membership pair that is not [shape index, id]");
    }
    // SAFETY: the shape holds a scope and a role list, checked above; via is a string the evaluator compares.
    const { scope, roles, via } = shape as SnapshotMembershipShape;
    return compact<Membership>({ scope, id, roles, via });
  });
}
