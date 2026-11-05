import type { MembershipFilter } from "./membership-filter.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { ExpandedSnapshot, SnapshotAssignable } from "./snapshot-types.ts";
import type { Subject } from "./subject.ts";

import { compact } from "./compact.ts";
import { filterMemberships } from "./membership-filter.ts";
import { scopeList } from "./scopes.ts";
import { heldRoleNames } from "./snapshot-subject.ts";
import { findRole, listRoles, synthesiseRole } from "./vocabulary.ts";

function assignableEntry(
  snapshot: ExpandedSnapshot,
  tenant: string | undefined,
): SnapshotAssignable | undefined {
  if (tenant === undefined) {
    return undefined;
  }
  return snapshot.assignable?.find((entry) => entry.tenant === tenant);
}

/**
 * The members of a snapshot instance that only read the snapshot: memberships,
 * tenants, held roles, audiences and what the subject may hand out. A client
 * reads them without the evaluator.
 */
export function snapshotReads(
  snapshot: ExpandedSnapshot,
  subject: Subject,
): Pick<
  PermDock,
  | "memberships"
  | "tenants"
  | "heldRoles"
  | "audiences"
  | "assignableRoles"
  | "assignablePermissions"
  | "assignableLevels"
> {
  return {
    memberships(filter?: MembershipFilter) {
      return filterMemberships(subject.principal?.memberships ?? [], filter);
    },
    tenants() {
      return snapshot.tenants;
    },
    heldRoles(query?: {
      readonly tenant?: string;
      readonly scope?: string;
      readonly id?: string;
    }) {
      const names = heldRoleNames(
        subject,
        query?.tenant ?? subject.principal?.tenant,
        scopeList(snapshot.scopes),
        compact({ scope: query?.scope, id: query?.id, rank: snapshot.roles }),
      );
      const tree = snapshot.vocabulary?.roles;
      return names.map((name) => findRole(tree, name) ?? synthesiseRole(name));
    },
    audiences() {
      const tenant = subject.principal?.tenant;
      if (tenant === snapshot.subject.principal?.tenant) {
        return snapshot.audiences ?? [];
      }
      const tree = snapshot.vocabulary?.roles;
      const out: string[] = [];
      for (const name of heldRoleNames(
        subject,
        tenant,
        scopeList(snapshot.scopes),
        { rank: snapshot.roles },
      )) {
        const audience = findRole(tree, name)?.meta.audience;
        if (typeof audience === "string" && !out.includes(audience)) {
          out.push(audience);
        }
      }
      return out;
    },
    assignableRoles(query?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }) {
      if (query?.scope === "global") {
        return [];
      }
      const tenant = query?.tenant ?? subject.principal?.tenant;
      const tree = snapshot.vocabulary?.roles;
      if (snapshot.assignable !== undefined) {
        const entry = assignableEntry(snapshot, tenant);
        return (entry?.roles ?? []).map(
          (name) =>
            findRole(tree, name) ?? synthesiseRole(name, { assignable: true }),
        );
      }
      const names = new Set(
        heldRoleNames(subject, tenant, scopeList(snapshot.scopes)),
      );
      return listRoles(tree).filter(
        (leaf) => leaf.assignable && names.has(leaf.key),
      );
    },
    assignablePermissions(query?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }) {
      if (query?.scope === "global") {
        return [];
      }
      const tenant = query?.tenant ?? subject.principal?.tenant;
      return assignableEntry(snapshot, tenant)?.permissions ?? [];
    },
    assignableLevels(
      permission: Permission,
      query?: { readonly tenant?: string; readonly scope?: "global" },
    ) {
      if (query?.scope === "global") {
        return [];
      }
      const levels = assignableEntry(
        snapshot,
        query?.tenant ?? subject.principal?.tenant,
      )?.levels;
      if (levels === undefined || !Object.hasOwn(levels, permission.key)) {
        return [];
      }
      const names = levels[permission.key];
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === "string")
        : [];
    },
  };
}
