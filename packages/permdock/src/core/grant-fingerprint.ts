import type { Condition } from "../conditions/ast.ts";
import type { Grantee } from "./grantee.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Snapshot, SnapshotGrantTerms } from "./snapshot-types.ts";

import { canonicalJson } from "./canonical-json.ts";
import { findPermission } from "./permission-registry.ts";
import { sha256Digest } from "./sha256.ts";

const PREFIX = "gf1:";

/** Grant terms that name a role or a grantee instead of deciding. */
const NAMES: ReadonlySet<string> = new Set([
  "role",
  "name",
  "meta",
  "to",
  "membership",
]);

/**
 * Condition operators whose answer depends on something the grants do not
 * carry.
 */
const LIVE_OPS: ReadonlySet<string> = new Set([
  "opaque",
  "sqlFunction",
  "liveSession",
]);

function conditionIsLive(condition: Condition | undefined): boolean {
  if (condition === undefined) {
    return false;
  }
  if (LIVE_OPS.has(condition.op)) {
    return true;
  }
  if (condition.op === "and" || condition.op === "or") {
    return condition.conditions.some(conditionIsLive);
  }
  return condition.op === "not" && conditionIsLive(condition.condition);
}

/**
 * What a grant decides, without the name of the role that carries it: two roles
 * that grant the same permission under the same terms read the same rows.
 */
function decisive(terms: SnapshotGrantTerms): unknown {
  const rest = Object.fromEntries(
    Object.entries(terms).filter(([key]) => !NAMES.has(key)),
  );
  const { to, membership } = terms;
  const grantees: readonly Grantee[] = Array.isArray(to) ? to : [to];
  const direct = grantees.filter((grantee) => grantee.kind !== "role");
  return {
    ...rest,
    ...(direct.length === 0 ? {} : { to: direct }),
    ...(membership === undefined
      ? {}
      : {
          membership: {
            scope: membership.scope,
            id: membership.id,
            ...(membership.expiresAt === undefined
              ? {}
              : { expiresAt: membership.expiresAt }),
          },
        }),
  };
}

function termsOf(
  snapshot: Snapshot,
  cond: number | readonly number[],
): readonly SnapshotGrantTerms[] {
  const indexes = typeof cond === "number" ? [cond] : cond;
  return indexes.flatMap((index) => {
    const terms = snapshot.conditions[index];
    return terms === undefined ? [] : [terms];
  });
}

/**
 * A digest of what `permdock` grants for `permissions` in its tenant, or `null`
 * when two callers with the same digest could still be decided differently or
 * when it grants none of them. Callers with equal digests hold the same grants,
 * denials, conditions, approval floors and memberships for those permissions,
 * so a read that only those permissions filter returns the same rows to both.
 *
 * `null` for a delegated, simulated or tenant-less instance and for a grant
 * whose condition is `opaque`, a `sqlFunction`, a `liveSession` check or not
 * `portable`: those depend on state the digest cannot name.
 */
export function grantFingerprint(
  permdock: PermDock,
  permissions: readonly (Permission | string)[],
): string | null {
  const principal = permdock.subject.principal;
  if (principal?.tenant === undefined) {
    return null;
  }
  const leaves: Permission[] = [];
  for (const wanted of permissions) {
    const leaf =
      typeof wanted === "string"
        ? findPermission(permdock.permissions, wanted)
        : wanted;
    if (leaf === undefined) {
      return null;
    }
    leaves.push(leaf);
  }
  if (leaves.length === 0) {
    return null;
  }
  const snapshot = permdock.snapshot({ include: leaves, omitAssignable: true });
  if (
    snapshot.simulated === true ||
    snapshot.local === true ||
    snapshot.subject.delegation !== undefined ||
    (snapshot.delegated?.length ?? 0) > 0
  ) {
    return null;
  }
  const keys = new Set(leaves.map((leaf) => leaf.key));
  const grants = snapshot.grants
    .filter((grant) => keys.has(grant.permission))
    .flatMap((grant) =>
      termsOf(snapshot, grant.cond).map((terms) => ({
        permission: grant.permission,
        terms,
        decisive: decisive(terms),
      })),
    );
  if (
    grants.some(
      ({ terms }) =>
        terms.portable === false ||
        conditionIsLive(terms.where) ||
        conditionIsLive(terms.check),
    )
  ) {
    return null;
  }
  if (!grants.some(({ terms }) => terms.effect === "allow")) {
    return null;
  }
  const notEntitled = (snapshot.notEntitled ?? []).filter((entry) =>
    keys.has(entry.permission),
  );
  const digest = sha256Digest(
    canonicalJson({
      tenant: principal.tenant,
      grants: grants
        .map(({ permission, decisive: terms }) =>
          canonicalJson({ permission, terms }),
        )
        .toSorted(),
      notEntitled: notEntitled.map(({ permission }) => permission).toSorted(),
    }),
  );
  return `${PREFIX}${digest.slice("sha-256:".length)}`;
}
