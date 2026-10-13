import type { Approver } from "../../core/approvers.ts";
import type { MembershipSource } from "../../core/interfaces.ts";
import type { PermDock } from "../../core/permdock.ts";
import type { Permission } from "../../core/permission-types.ts";
import type { Grant, Policy } from "../../core/policy-types.ts";
import type {
  AccessReview,
  AccessReviewItem,
  AccessReviewStore,
} from "./types.ts";

import { flattenGrantee } from "../../core/grantee.ts";
import { AccessReviewError } from "./errors.ts";

export type AccessReviewHolder = {
  readonly principal: string;
  readonly permission: string;
  readonly via: readonly string[];
};

export type StartAccessReviewInput = {
  readonly id: string;
  readonly permissions: readonly Permission[];
  readonly reviewers: Approver | readonly Approver[];
  readonly dueAt: string;
};

export type StartAccessReviewOptions = {
  readonly store: AccessReviewStore;
  /**
   * Replaces the membership listing. The Supabase recipe passes the rows of
   * `permitted_<scope>_users`. `complete` defaults to `true` for this path.
   */
  readonly holders?: readonly AccessReviewHolder[];
  readonly complete?: boolean;
  readonly memberships?: MembershipSource;
  /** Scope name passed to `memberships.list`. Defaults to `tenant`. */
  readonly scope?: string;
  /**
   * An instance for one member, used to confirm each holding with a rowless
   * `decide`. Required when `holders` is omitted.
   */
  readonly permdockFor?: (principalId: string) => PermDock | Promise<PermDock>;
  /**
   * When set, a global role, a plan, a relation or an inherit grant on a
   * reviewed permission makes `complete` false. Without it the membership
   * path is incomplete, because those holders cannot be listed from a tenant.
   */
  readonly policy?: Policy;
  readonly now?: Date;
};

function itemId(review: string, principal: string, permission: string): string {
  return `${review}:${principal}:${permission}`;
}

function populationComplete(
  policy: Policy | undefined,
  keys: ReadonlySet<string>,
): boolean {
  if (policy === undefined) {
    return false;
  }
  for (const grant of policy.grants) {
    if (grant.effect !== "allow" || !keys.has(grant.permission.key)) {
      continue;
    }
    if (!enumerable(grant)) {
      return false;
    }
  }
  return true;
}

function enumerable(grant: Grant): boolean {
  for (const item of flattenGrantee(grant.to)) {
    if (
      item.kind === "plan" ||
      item.kind === "relation" ||
      item.kind === "inherit"
    ) {
      return false;
    }
    if (item.kind === "role" && item.scope === "global") {
      return false;
    }
  }
  return true;
}

async function fromMembers(
  tenant: string,
  keys: readonly Permission[],
  options: StartAccessReviewOptions,
): Promise<{
  readonly holders: readonly AccessReviewHolder[];
  readonly complete: boolean;
}> {
  const source = options.memberships;
  const permdockFor = options.permdockFor;
  const keySet = new Set(keys.map((permission) => permission.key));
  if (source?.list === undefined || permdockFor === undefined) {
    return { holders: [], complete: false };
  }
  try {
    const members = await source.list({
      scope: options.scope ?? "tenant",
      id: tenant,
    });
    const groups = await Promise.all(
      members.map(async (member) => {
        const instance = await permdockFor(member.principal.id);
        const via = member.membership.roles;
        return keys.flatMap((permission) => {
          // SAFETY: decide's instance and collection overloads share one implementation; a rowless check answers at tenant level.
          const decide = instance.decide as (
            permission: Permission,
            data?: unknown,
          ) => ReturnType<PermDock["decide"]>;
          return decide(permission).outcome === "granted"
            ? [
                {
                  principal: member.principal.id,
                  permission: permission.key,
                  via,
                },
              ]
            : [];
        });
      }),
    );
    return {
      holders: groups.flat(),
      complete: populationComplete(options.policy, keySet),
    };
  } catch {
    return { holders: [], complete: false };
  }
}

function itemsFrom(
  reviewId: string,
  holders: readonly AccessReviewHolder[],
  keys: ReadonlySet<string>,
): readonly AccessReviewItem[] {
  const seen = new Set<string>();
  const items: AccessReviewItem[] = [];
  for (const holder of holders) {
    if (!keys.has(holder.permission) || holder.principal.length === 0) {
      continue;
    }
    const id = itemId(reviewId, holder.principal, holder.permission);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    items.push({
      v: 1,
      id,
      review: reviewId,
      principal: holder.principal,
      permission: holder.permission,
      via: holder.via,
      status: "pending",
    });
  }
  return items;
}

/**
 * Opens a review of who holds `permissions` in the caller's active tenant.
 * The caller must be signed in. PermDock stores the population and does not
 * revoke anything: the application changes the source, then `markApplied`.
 */
export async function startAccessReview(
  permdock: PermDock,
  input: StartAccessReviewInput,
  options: StartAccessReviewOptions,
): Promise<AccessReview> {
  const principal = permdock.subject.principal;
  const tenant = principal?.tenant;
  if (principal === null || tenant === undefined) {
    throw new AccessReviewError(
      "reviewer-unauthenticated",
      "access review needs a tenant member",
    );
  }
  if (
    input.permissions.length === 0 ||
    !Number.isFinite(Date.parse(input.dueAt))
  ) {
    throw new TypeError(
      "PermDock: an access review needs permissions and a due date",
    );
  }
  const keys = new Set(input.permissions.map((permission) => permission.key));
  const now = options.now ?? new Date();
  const listed =
    options.holders === undefined
      ? await fromMembers(tenant, input.permissions, options)
      : {
          holders: options.holders,
          complete: options.complete ?? true,
        };
  const review: AccessReview = {
    v: 1,
    id: input.id,
    tenant,
    permissions: [...keys],
    reviewers: input.reviewers,
    createdBy: principal.id,
    createdAt: now.toISOString(),
    dueAt: input.dueAt,
    status: "open",
    complete: listed.complete,
  };
  await options.store.create(review, itemsFrom(input.id, listed.holders, keys));
  return review;
}
