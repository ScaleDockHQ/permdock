import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { ResourceNode } from "./permission-types.ts";
import type { Scope } from "./scopes.ts";
import type { ExpandedSnapshot, SnapshotGrant } from "./snapshot-types.ts";
import type { Delegation } from "./subject.ts";

import { compact } from "./compact.ts";
import {
  coveredByDelegation,
  interactiveOnlyRefuses,
  readOnlyActorRefuses,
} from "./delegation.ts";
import { expandedViewOf } from "./expanded-view.ts";
import { getResource } from "./permission-registry.ts";
import { resolveScope, scopeList, tenantOf } from "./scopes.ts";
import { expandSnapshot } from "./snapshot-compact.ts";
import {
  isMembershipExpired,
  nowSeconds,
  partitionsOf,
  relatesTo,
  scopeField,
} from "./tenancy.ts";
import { isActive, readWireValidity } from "./validity.ts";

function delegationMayCover(
  permission: Permission,
  delegation: Delegation | undefined,
  hasActor: boolean,
): boolean {
  const identifiers = [
    ...(delegation?.access ?? []),
    ...(delegation?.authorizationDetails ?? []),
  ].flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    typeof entry["identifier"] === "string"
      ? [entry["identifier"]]
      : [],
  );
  return [undefined, ...identifiers].some(
    (id) =>
      coveredByDelegation(permission, delegation, id, hasActor) === undefined,
  );
}

function blocksEveryRow(grant: SnapshotGrant): boolean {
  return (
    grant.effect === "deny" &&
    grant.where === undefined &&
    grant.check === undefined &&
    grant.portable !== false &&
    grant.fields === undefined &&
    (grant.scope === undefined || grant.scope === "tenant")
  );
}

function withinDelegation(
  permdock: PermDock,
  permission: Permission,
  ceiling: readonly string[] | undefined,
): boolean {
  return (
    (ceiling === undefined || ceiling.includes(permission.key)) &&
    !readOnlyActorRefuses(permdock.subject.actor, permission) &&
    !interactiveOnlyRefuses(permdock.subject, permission) &&
    delegationMayCover(
      permission,
      permdock.subject.delegation,
      permdock.subject.actor !== undefined && ceiling === undefined,
    )
  );
}

/** One instance's expanded snapshot, its grants indexed by permission key. */
type UseView = {
  readonly snapshot: ExpandedSnapshot;
  readonly byPermission: ReadonlyMap<string, readonly SnapshotGrant[]>;
};

function buildView(permdock: PermDock): UseView {
  const snapshot =
    expandedViewOf(permdock)?.() ?? expandSnapshot(permdock.snapshot());
  const byPermission = new Map<string, SnapshotGrant[]>();
  for (const grant of snapshot.grants) {
    const list = byPermission.get(grant.permission) ?? [];
    list.push(grant);
    byPermission.set(grant.permission, list);
  }
  return { snapshot, byPermission };
}

/**
 * Whether the subject's delegation, its delegated ceiling and a read-only actor
 * leave `permission` within reach, whatever the grants say. A hint, never a
 * decision.
 */
export function delegationAllows(
  permdock: PermDock,
  permission: Permission,
): boolean {
  try {
    const snapshot = expandSnapshot(permdock.snapshot());
    return withinDelegation(permdock, permission, snapshot.delegated);
  } catch {
    return false;
  }
}

/**
 * Whether `permission` could be granted to this instance's subject for some
 * row: the grants its snapshot carries for the active tenant, minus an
 * unconditional deny, within its delegation. A listing hint for tools and
 * skills, never a decision; the call itself is decided in full.
 */
export function mayUse(permdock: PermDock, permission: Permission): boolean {
  return mayUseOf(permdock)(permission);
}

/**
 * `mayUse` for one instance, reading the instance snapshot on the first call
 * only: a tool listing asks once per tool.
 */
export function mayUseOf(
  permdock: PermDock,
): (permission: Permission) => boolean {
  let view: UseView | undefined;
  return (permission) => {
    try {
      view ??= buildView(permdock);
      return mayUseIn(permdock, permission, view);
    } catch {
      return false;
    }
  };
}

function mayUseIn(
  permdock: PermDock,
  permission: Permission,
  view: UseView,
): boolean {
  const { snapshot, byPermission } = view;
  if (!withinDelegation(permdock, permission, snapshot.delegated)) {
    return false;
  }
  const tenant = permdock.subject.principal?.tenant;
  const scopes = scopeList(snapshot.scopes);
  const grants = (byPermission.get(permission.key) ?? []).filter((grant) => {
    const owner =
      grant.membership === undefined
        ? undefined
        : tenantOf(grant.membership, scopes);
    // A tenant the subject does not hold is not "no tenant".
    return (
      owner === undefined ||
      (permdock.subject.principal?.unheldTenant === undefined &&
        (tenant === undefined || owner === tenant))
    );
  });
  if (grants.some(blocksEveryRow)) {
    return false;
  }
  return grants.some((grant) => grant.effect === "allow");
}

function isConditioned(grant: SnapshotGrant): boolean {
  return (
    grant.where !== undefined ||
    grant.check !== undefined ||
    grant.validity !== undefined ||
    grant.portable === false
  );
}

export type PermittedIdsOptions = {
  readonly within?: string;
  readonly conditioned?: boolean;
};

/**
 * The instances of `scope` in which the subject holds `permission`, from its
 * live memberships of exactly that scope, within its delegation: by default
 * those with an allow that carries no row condition (`where`, `check`, a
 * validity window or a non-portable test; a `fields` limit is not a row
 * condition), minus the instances any deny of the permission reaches. The
 * in-process mirror of the SQL `permitted_<scope>_ids_by_permission`. With
 * `conditioned: true` it also lists the instances where a conditioned allow
 * applies, minus only unconditional denies, as
 * `permitted_<scope>_ids_by_permission(p_permission, true)` does. A listing,
 * never a decision: a row's own check still runs `can`.
 */
export function permittedIds(
  permdock: PermDock,
  permission: Permission,
  scope: string,
  options: PermittedIdsOptions = {},
): readonly string[] {
  try {
    const snapshot = expandSnapshot(permdock.snapshot({ tenants: "all" }));
    const scopes = scopeList(snapshot.scopes);
    const name = resolveScope(scopes, scope);
    if (
      name === undefined ||
      !withinDelegation(permdock, permission, snapshot.delegated)
    ) {
      return [];
    }
    const conditioned = options.conditioned === true;
    const now = nowSeconds();
    const allowed = new Set<string>();
    const denied = new Set<string>();
    for (const grant of snapshot.grants) {
      const membership = grant.membership;
      if (
        grant.permission !== permission.key ||
        grant.scope !== name ||
        membership?.scope !== name ||
        membership.id === undefined ||
        isMembershipExpired(membership, now) ||
        (options.within !== undefined &&
          tenantOf(membership, scopes) !== options.within)
      ) {
        continue;
      }
      if (grant.effect === "deny") {
        if (!conditioned || !isConditioned(grant)) {
          denied.add(membership.id);
        }
      } else if (
        (conditioned || !isConditioned(grant)) &&
        isActive(readWireValidity(grant.validity), now)
      ) {
        allowed.add(membership.id);
      }
    }
    return [...allowed].filter((id) => !denied.has(id)).toSorted();
  } catch {
    return [];
  }
}

export type PermittedScopeIdsOptions = {
  /**
   * The tenant the instances lie in. Defaults to the active tenant; with none,
   * every tenant the subject holds.
   */
  readonly tenant?: string;
  /**
   * The scope whose instances to list. Defaults to the outermost scope the
   * permission's resource is partitioned by, else the first scope.
   */
  readonly scope?: string;
  /** As `PermittedIdsOptions.conditioned`. */
  readonly conditioned?: boolean;
};

/** The resource node of `permission`; none on an instance built from a snapshot. */
function nodeOf(
  permdock: PermDock,
  permission: Permission,
): ResourceNode | undefined {
  try {
    return getResource(permdock.permissions, permission.resource);
  } catch {
    return undefined;
  }
}

/**
 * The scope a listing of `permission` reads, and the scopes it resolves
 * against.
 */
function listingScope(
  permdock: PermDock,
  permission: Permission,
  scope: string | undefined,
): { readonly name: string; readonly scopes: readonly Scope[] } | undefined {
  const scopes = scopeList(
    expandSnapshot(permdock.snapshot({ tenants: "all" })).scopes,
  );
  if (scope !== undefined) {
    const name = resolveScope(scopes, scope);
    return name === undefined ? undefined : { name, scopes };
  }
  const node = nodeOf(permdock, permission);
  const name =
    (node === undefined ? undefined : partitionsOf(node, scopes)[0]) ??
    scopes[0]?.name;
  return name === undefined ? undefined : { name, scopes };
}

/**
 * The instances of one scope, within one tenant, in which the subject holds
 * `permission`: `permittedIds` for the scope the permission's resource lies in,
 * the in-process mirror of the SQL `permitted_<scope>_id_array`. A listing,
 * never a decision.
 */
export function permittedScopeIds(
  permdock: PermDock,
  permission: Permission,
  options: PermittedScopeIdsOptions = {},
): readonly string[] {
  try {
    const listing = listingScope(permdock, permission, options.scope);
    if (listing === undefined) {
      return [];
    }
    return permittedIds(
      permdock,
      permission,
      listing.name,
      compact({
        within: options.tenant ?? permdock.subject.principal?.tenant,
        conditioned: options.conditioned,
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Whether the rows of `permission`'s resource are the instances of `scope`
 * (`relations: { self: { field: 'id', memberOf: <scope> } }`), so an id alone
 * names the instance a grant is held on.
 */
function idsAreInstances(
  scope: string,
  scopes: readonly Scope[],
  node: ResourceNode | undefined,
): boolean {
  if (node === undefined) {
    return false;
  }
  const field = scopeField(node, scope, scopes);
  return (
    field !== undefined &&
    field === (node.id ?? "id") &&
    relatesTo(node, field, scope, scopes)
  );
}

/**
 * The ids, in the order given and each once, that name an instance of the
 * permission's scope on which the subject holds it, without loading rows. A
 * resource whose id is not a scope instance keeps nothing: its rows decide, so
 * use `filter` or `decideEach` with them. By default only grants with no row
 * condition count. A listing, never a decision.
 */
export function filterIds(
  permdock: PermDock,
  permission: Permission,
  ids: readonly string[],
): readonly string[] {
  if (ids.length === 0) {
    return [];
  }
  try {
    const listing = listingScope(permdock, permission, undefined);
    const node = nodeOf(permdock, permission);
    if (
      listing === undefined ||
      !idsAreInstances(listing.name, listing.scopes, node)
    ) {
      return [];
    }
    const held = new Set(permittedIds(permdock, permission, listing.name));
    return [...new Set(ids)].filter((id) => held.has(id));
  } catch {
    return [];
  }
}
