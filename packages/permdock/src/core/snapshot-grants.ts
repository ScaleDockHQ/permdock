import type { Permission, ResourceNode } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { CustomRole, Membership, Subject } from "./subject.ts";

import { type Condition, hasConditionOp } from "../conditions/ast.ts";
import { compact } from "./compact.ts";
import {
  type CustomGrant,
  customGrantsFor,
  holdsCustomRole,
  holdsGlobalCustomRole,
} from "./custom-roles.ts";
import { coversRequirements } from "./delegation.ts";
import { freezeDeep } from "./freeze.ts";
import { combineWhere, matchGrantee } from "./grantee-match.ts";
import { type GranteeMatch, flattenGrantee } from "./grantee.ts";
import { getResource, listPermissions } from "./permission-registry.ts";
import { declaredRoleNames, grantList } from "./policy.ts";
import { requirementCondition } from "./requires-conditions.ts";
import { isPrincipalRelation } from "./resource-relations.ts";
import { expandRoleNames } from "./role-loading.ts";
import { keepsPermission, scopeList, tenantOf } from "./scopes.ts";
import { nowSeconds } from "./tenancy.ts";

/** A grant on a relation with a `period` is decided on the server, where the clock is. */
export function periodBound(policy: Policy, grant: Grant): boolean {
  const relations = policy.resources.get(grant.permission.resource)?.relations;
  return flattenGrantee(grant.to).some((item) => {
    if (item.kind !== "relation") {
      return false;
    }
    const spec = relations?.[item.relation];
    return isPrincipalRelation(spec) && spec.period !== undefined;
  });
}

export function includePrefixes(
  include:
    | readonly (Permission | { readonly [key: string]: unknown })[]
    | undefined,
): readonly string[] | undefined {
  if (include === undefined) {
    return undefined;
  }
  return include.map((item) => {
    if ("key" in item && typeof item.key === "string") {
      return item.key;
    }
    // SAFETY: include takes leaves or resource nodes, the shapes listPermissions walks.
    const leaves = listPermissions(item as never);
    const first = leaves[0];
    if (first === undefined) {
      return "";
    }
    const parts = first.key.split(".");
    parts.pop();
    return parts.join(".");
  });
}

/**
 * The grant with its grantee's row condition. A graph relation needs the
 * `RelationSource`, which snapshots and `where()` do not carry, so the grant
 * becomes server-only (`portable: false`) there.
 */
function graphAware(grant: Grant, where: Grant["where"]): Grant {
  const combined = combineWhere(grant.where, where);
  const graph = hasConditionOp(combined, "related");
  const inherits = flattenGrantee(grant.to).some(
    (item) => item.kind === "inherit",
  );
  return freezeDeep(
    compact({
      ...grant,
      where: combined,
      portable: graph ? false : grant.portable,
      graph: graph && grant.portable && !inherits ? (true as const) : undefined,
    }),
  );
}

/**
 * `where()` keeps a grant that is server-only because it reads the graph:
 * its `related` nodes compile to subqueries given relation mappings.
 */
export function whereGrant(grant: Grant): Grant {
  return grant.graph === true
    ? freezeDeep({ ...grant, portable: true })
    : grant;
}

/**
 * Every grant the subject may reach, once per membership that holds all of
 * its scoped roles, so a client can check that membership's tenant, team or
 * resource. A scoped role held only globally reaches nothing.
 */
export function collectSnapshotGrants(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  now: number = nowSeconds(),
  customGrants: readonly CustomGrant[] = customGrantsFor(policy, customRoles),
  mode: "held" | "not-entitled" = "held",
): readonly { readonly grant: Grant; readonly membership?: Membership }[] {
  const skip = (grant: Grant, match: GranteeMatch): boolean =>
    mode === "held"
      ? !match.matched
      : match.matched ||
        match.reason !== "not-entitled" ||
        grant.effect !== "allow";
  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const global = expandRoleNames(
    subject.principal?.roles ?? [],
    declared,
    customRoles,
    subject.principal?.tenant,
  );
  const held = (subject.principal?.memberships ?? []).map((membership) => ({
    membership,
    roles: new Set(
      expandRoleNames(
        membership.roles,
        declared,
        customRoles,
        tenantOf(membership, scopes),
      ).roles,
    ),
  }));
  // No cascade: a scoped role counts only on a membership of its own scope.
  const holds = (
    entry: (typeof held)[number],
    item: { readonly role: string; readonly scope: Grant["scope"] },
  ): boolean =>
    entry.roles.has(item.role) &&
    (typeof item.scope === "string"
      ? entry.membership.scope === item.scope
      : entry.membership.on !== undefined);
  const requirementOf = (
    grant: Grant,
    resource: ResourceNode | undefined,
  ): Condition | undefined =>
    grant.requires === undefined || grant.effect !== "allow"
      ? undefined
      : requirementCondition(
          policy,
          subject,
          grant.requires,
          resource,
          now,
          customRoles,
          customGrants,
        );
  const out: { readonly grant: Grant; readonly membership?: Membership }[] = [];
  for (const grant of grantList(policy)) {
    if (
      mode === "held" &&
      !coversRequirements(
        policy.permissions,
        grant.requires,
        subject.delegation,
      )
    ) {
      continue;
    }
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
    );
    if (skip(grant, match)) {
      continue;
    }
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === "role",
    );
    if (roleItems.length > 0 && subject.principal === null) {
      continue;
    }
    const globalOk = roleItems.every(
      (item) => item.scope !== "global" || global.roles.includes(item.role),
    );
    if (!globalOk) {
      continue;
    }
    const merged: Grant = graphAware(
      grant,
      combineWhere(match.where, requirementOf(grant, resource)),
    );
    const scoped = roleItems.filter((item) => item.scope !== "global");
    if (scoped.length === 0) {
      out.push({ grant: merged });
      continue;
    }
    for (const entry of held) {
      if (
        keepsPermission(entry.membership, grant.permission.key) &&
        scoped.every((item) => item.kind === "role" && holds(entry, item))
      ) {
        out.push({ grant: merged, membership: entry.membership });
      }
    }
  }
  for (const { grant, role } of customGrants) {
    const globalHeld = holdsGlobalCustomRole(subject.principal?.roles, role);
    const holders = held.filter(
      (entry) =>
        keepsPermission(entry.membership, grant.permission.key) &&
        holdsCustomRole(entry.membership, role, scopes),
    );
    if (holders.length === 0 && !globalHeld) {
      continue;
    }
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
    );
    if (skip(grant, match)) {
      continue;
    }
    const merged: Grant = graphAware(
      grant,
      combineWhere(match.where, requirementOf(grant, resource)),
    );
    if (globalHeld) {
      out.push({ grant: merged });
    }
    for (const entry of holders) {
      out.push({ grant: merged, membership: entry.membership });
    }
  }
  const fresh = policy.fresh ?? [];
  if (mode === "held" && subject.stale === true && fresh.length > 0) {
    return out.filter(
      ({ grant }) =>
        grant.effect === "deny" || !fresh.includes(grant.permission.key),
    );
  }
  return out;
}
