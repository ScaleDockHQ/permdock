import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Snapshot, SnapshotAssignable } from "./snapshot-types.ts";
import type { CustomRole, Subject } from "./subject.ts";

import { assignableIn } from "./assignable.ts";
import { compact } from "./compact.ts";
import { type CustomGrant, customGrantsFor } from "./custom-roles.ts";
import { delegatedPermissions, readOnlyActorRefuses } from "./delegation.ts";
import { freezeDeep } from "./freeze.ts";
import { heldRoleNames } from "./held-roles.ts";
import { getResource } from "./permission-registry.ts";
import { audiencesOf } from "./role-rank.ts";
import {
  collectSnapshotGrants,
  includePrefixes,
  periodBound,
} from "./snapshot-grants.ts";
import { buildSnapshot } from "./snapshot.ts";
import { nowSeconds, partitionsOf, scopeField } from "./tenancy.ts";

export type SnapshotInclude = readonly (
  | Permission
  | { readonly [key: string]: unknown }
)[];

/**
 * The one path from a resolved subject to a `Snapshot`; pure apart from the
 * default clock.
 */
export function snapshotOf(
  policy: Policy,
  subject: Subject,
  options: {
    readonly customRoles: readonly CustomRole[];
    readonly customGrants?: readonly CustomGrant[];
    /** Role names `CustomRoleSource.assignable` returned, per tenant. */
    readonly assignable?: ReadonlyMap<string, readonly string[]>;
    readonly include?: SnapshotInclude;
    readonly tenants?: "all";
    readonly simulated?: boolean;
    readonly now?: number;
  },
): Snapshot {
  const now = options.now ?? nowSeconds();
  const customGrants =
    options.customGrants ?? customGrantsFor(policy, options.customRoles);
  const roles = heldRoleNames(
    policy,
    subject,
    subject.principal?.tenant,
    undefined,
    now,
  );
  const audiences = audiencesOf(policy, roles);
  const delegated = delegatedPermissions(
    policy.delegations,
    subject,
    new Set(roles),
    now,
  );
  return buildSnapshot(
    compact<Parameters<typeof buildSnapshot>[0]>({
      subject,
      roles,
      audiences: audiences.length === 0 ? undefined : audiences,
      notEntitled: collectSnapshotGrants(
        policy,
        subject,
        options.customRoles,
        now,
        customGrants,
        "not-entitled",
      ),
      grants: collectSnapshotGrants(
        policy,
        subject,
        options.customRoles,
        now,
        customGrants,
      )
        // `delegated` already narrows a read-only actor; without it the client has no actor to check.
        .filter(
          (item) =>
            delegated !== undefined ||
            item.grant.effect === "deny" ||
            !readOnlyActorRefuses(subject.actor, item.grant.permission),
        )
        .map((item) =>
          periodBound(policy, item.grant)
            ? Object.assign({}, item, {
                grant: freezeDeep({ ...item.grant, portable: false }),
              })
            : item,
        ),
      include: includePrefixes(options.include),
      tenants: options.tenants,
      simulated: options.simulated,
      now: Math.floor(now),
      vocabulary: policy.vocabulary,
      scopes: snapshotScopes(policy),
      idOf: (name: string) => getResource(policy.permissions, name)?.id,
      delegated,
      assignable: (tenant: string) => {
        const found = assignableIn(
          policy,
          subject,
          options.customRoles,
          customGrants,
          tenant,
          options.assignable?.get(tenant),
          now,
        );
        return compact<SnapshotAssignable>({
          tenant,
          roles: found.roles.map((leaf) => leaf.key),
          permissions: found.permissions,
          levels:
            Object.keys(found.levels).length === 0 ? undefined : found.levels,
        });
      },
    }),
  );
}

/**
 * The policy's scopes as snapshots and `permdock cloud push` carry them, with
 * the resources each partitions.
 */
export function snapshotScopes(policy: Policy): Snapshot["scopes"] {
  if (policy.scopes.length === 0) {
    return undefined;
  }
  const resources = [...policy.resources.values()];
  return policy.scopes.map((scope) => {
    const nodes = resources.filter((node) =>
      partitionsOf(node, policy.scopes).includes(scope.name),
    );
    const partitioned = nodes.map((node) => node.name);
    const fields = Object.fromEntries(
      nodes.flatMap((node) => {
        const field = scopeField(node, scope.name, policy.scopes);
        return field === undefined || field === scope.key
          ? []
          : [[node.name, field] as const];
      }),
    );
    return compact<NonNullable<Snapshot["scopes"]>[number]>({
      name: scope.name,
      key: scope.key ?? "",
      within: scope.within,
      resources: partitioned.length === 0 ? undefined : partitioned,
      fields: Object.keys(fields).length === 0 ? undefined : fields,
    });
  });
}
