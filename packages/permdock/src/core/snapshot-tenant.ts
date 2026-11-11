import type { Snapshot, SnapshotStatic } from "./snapshot-types.ts";

import { freezeDeep } from "./freeze.ts";
import { scopeList, tenantOf } from "./scopes.ts";

/**
 * `snapshot` with only the memberships in a tenant it lists, plus those outside
 * any tenant, so its size does not grow with the subject's other memberships.
 * The grants of an unlisted tenant are already left out, and `static.held`
 * indexes are renumbered to the kept memberships.
 */
export function listedTenantSnapshot(snapshot: Snapshot): Snapshot {
  const principal = snapshot.subject.principal;
  const memberships = principal?.memberships;
  if (principal === null || memberships === undefined) {
    return snapshot;
  }
  const scopes = scopeList(snapshot.scopes);
  const listed = new Set(snapshot.tenants);
  const renumbered = new Map<number, number>();
  const kept = memberships.filter((membership, at) => {
    const tenant = tenantOf(membership, scopes);
    if (tenant !== undefined && !listed.has(tenant)) {
      return false;
    }
    renumbered.set(at, renumbered.size);
    return true;
  });
  if (kept.length === memberships.length) {
    return snapshot;
  }
  const held = snapshot.static?.held.flatMap(
    ([role, at]): SnapshotStatic["held"] => {
      if (at === null) {
        return [[role, null]];
      }
      const next = renumbered.get(at);
      return next === undefined ? [] : [[role, next]];
    },
  );
  return freezeDeep({
    ...snapshot,
    subject: {
      ...snapshot.subject,
      principal: { ...principal, memberships: kept },
    },
    ...(snapshot.static === undefined || held === undefined
      ? {}
      : { static: { ...snapshot.static, held } }),
  });
}
