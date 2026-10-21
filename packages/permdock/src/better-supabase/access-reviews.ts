import type {
  AccessReview,
  AccessReviewItem,
  AccessReviewStore,
} from "../approvals/access-reviews/types.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { SupabaseRpcCaller } from "../supabase/postgrest.ts";

import { AccessReviewError } from "../approvals/access-reviews/errors.ts";
import { isRecord } from "../core/compact.ts";
import { flattenGrantee } from "../core/grantee.ts";
import { findPermission } from "../core/permission-registry.ts";
import { dateAt, type Instant } from "../core/time.ts";
import { callRpc } from "../supabase/postgrest.ts";

export type AccessReviewApplierOptions = {
  /**
   * A supabase-js client that may call the organizations and invitations block
   * functions. Pass the reviewer's client so the block's own permission and
   * role-ceiling checks run as the reviewer.
   */
  readonly client: SupabaseRpcCaller;
  readonly reviews: AccessReviewStore;
  /**
   * Decides whether a fallback role or an invitation's role grants the reviewed
   * permission.
   */
  readonly policy: Policy;
  /**
   * The role a revoked member moves to with `update_member_role`: one role, or
   * a map from the roles in the item's `via` to their fallback. A fallback that
   * still grants the permission, or none, removes the member with
   * `remove_member` instead.
   */
  readonly demoteTo?: string | Readonly<Record<string, string>>;
  /**
   * The member's email, for revoking the tenant's open invitations to it whose
   * role grants the permission. Without it invitations are left alone.
   */
  readonly email?: (
    userId: string,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * An instance for the member in the review's tenant, read after the change.
   * An item it still grants is not marked applied.
   */
  readonly permdockFor?: (
    principalId: string,
    tenant: string,
  ) => PermDock | Promise<PermDock>;
  /**
   * The schema of the block functions; better-supabase's default is
   * `better_supabase`.
   */
  readonly schema?: string;
  /** The scope review tenants are; defaults to the policy's first scope. */
  readonly scope?: string;
  readonly now?: Instant;
};

export type AccessReviewApplyFailure = {
  readonly item: string;
  readonly cause: string;
};

export type AccessReviewApplyResult = {
  /** Items marked applied, including those whose member was already gone. */
  readonly applied: readonly string[];
  /**
   * Items left unapplied, with the error the block function or the re-check
   * gave.
   */
  readonly failed: readonly AccessReviewApplyFailure[];
};

const NOT_MEMBER = "ORGANIZATION_NOT_MEMBER";

/**
 * The `hint` better-supabase's block functions raise their code in, or the
 * SQLSTATE.
 */
function errorCode(error: { readonly message: string }): string | undefined {
  if ("hint" in error && typeof error.hint === "string" && error.hint !== "") {
    return error.hint;
  }
  return "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

class RpcFailure extends Error {
  public readonly code: string | undefined;

  public constructor(fn: string, error: { readonly message: string }) {
    super(`${fn}: ${error.message}`);
    this.code = errorCode(error);
  }
}

/**
 * Whether a member holding `role` at `scope` holds `key` through it. A role the
 * policy does not declare, such as a custom role, counts as holding it.
 */
function roleGrants(
  policy: Policy,
  role: string,
  scope: string,
  key: string,
): boolean {
  if (!policy.index.declaredRoles.has(role)) {
    return true;
  }
  return policy.grants.some(
    (grant) =>
      grant.effect === "allow" &&
      grant.permission.key === key &&
      flattenGrantee(grant.to).some(
        (item) =>
          item.kind === "role" && item.role === role && item.scope === scope,
      ),
  );
}

function fallbackRole(
  demoteTo: AccessReviewApplierOptions["demoteTo"],
  via: readonly string[],
): string | undefined {
  if (demoteTo === undefined || typeof demoteTo === "string") {
    return demoteTo;
  }
  for (const role of via) {
    if (Object.hasOwn(demoteTo, role)) {
      return demoteTo[role];
    }
  }
  return undefined;
}

function invitationsOf(
  data: unknown,
): readonly {
  readonly id: string;
  readonly email: string;
  readonly role: string;
}[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((row: unknown) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["email"] === "string" &&
    typeof row["role"] === "string"
      ? [{ id: row["id"], email: row["email"], role: row["role"] }]
      : [],
  );
}

/**
 * Applies the revoked items of an access review to better-supabase's
 * organizations and invitations blocks, then marks each one applied. A revoked
 * member moves to the `demoteTo` role when the policy says that role lacks the
 * permission, and is removed otherwise. With `email`, the tenant's open
 * invitations to the member whose role grants the permission are revoked too. A
 * member who is no longer in the organization counts as applied. Any other
 * error leaves the item unapplied in `failed`, and one item's failure never
 * stops the others. Throws `review-not-found` for an unknown review.
 */
export function accessReviewApplier(
  options: AccessReviewApplierOptions,
): (reviewId: string) => Promise<AccessReviewApplyResult> {
  const schema = options.schema ?? "better_supabase";
  const scope = options.scope ?? options.policy.scopes[0]?.name ?? "tenant";
  const rpc = async (
    fn: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    const result = await callRpc(options.client, schema, fn, args);
    if (result.error !== null) {
      throw new RpcFailure(fn, result.error);
    }
    return result.data;
  };

  const changeMember = async (
    review: AccessReview,
    item: AccessReviewItem,
  ): Promise<void> => {
    const role = fallbackRole(options.demoteTo, item.via);
    try {
      if (
        role !== undefined &&
        !roleGrants(options.policy, role, scope, item.permission)
      ) {
        await rpc("update_member_role", {
          organization: review.tenant,
          member: item.principal,
          role,
        });
      } else {
        await rpc("remove_member", {
          organization: review.tenant,
          member: item.principal,
        });
      }
    } catch (error) {
      if (
        error instanceof RpcFailure &&
        (error.code === NOT_MEMBER || error.code === "P0002")
      ) {
        return;
      }
      throw error;
    }
  };

  const revokeInvitations = async (
    review: AccessReview,
    item: AccessReviewItem,
  ): Promise<void> => {
    const email = await options.email?.(item.principal);
    if (email === undefined || email === null || email === "") {
      return;
    }
    const wanted = email.toLowerCase();
    const open = invitationsOf(
      await rpc("list_organization_invitations", {
        organization: review.tenant,
      }),
    );
    await Promise.all(
      open
        .filter(
          (invitation) =>
            invitation.email.toLowerCase() === wanted &&
            roleGrants(options.policy, invitation.role, scope, item.permission),
        )
        .map((invitation) =>
          rpc("revoke_invitation", { invitation_id: invitation.id }),
        ),
    );
  };

  const stillHeld = async (
    review: AccessReview,
    item: AccessReviewItem,
  ): Promise<boolean> => {
    if (options.permdockFor === undefined) {
      return false;
    }
    const permission = findPermission(
      options.policy.permissions,
      item.permission,
    );
    if (permission === undefined) {
      throw new Error(
        `${item.permission} is not in the policy, so the change cannot be checked`,
      );
    }
    const instance = await options.permdockFor(item.principal, review.tenant);
    // SAFETY: decide's instance and collection overloads share one implementation; a rowless check answers at tenant level.
    const decide = instance.decide as (
      permission: Permission,
      data?: unknown,
    ) => ReturnType<PermDock["decide"]>;
    return decide(permission).outcome !== "denied";
  };

  /** `undefined` once the item is marked applied, else why it is not. */
  const applyItem = async (
    review: AccessReview,
    item: AccessReviewItem,
  ): Promise<string | undefined> => {
    try {
      await changeMember(review, item);
      await revokeInvitations(review, item);
      if (await stillHeld(review, item)) {
        return `${item.principal} still holds ${item.permission} after the change`;
      }
      await options.reviews.markApplied(
        review.id,
        item.id,
        dateAt(options.now).toISOString(),
      );
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  return async (reviewId) => {
    const review = await options.reviews.get(reviewId);
    if (review === null) {
      throw new AccessReviewError(
        "review-not-found",
        `access review ${reviewId} not found`,
      );
    }
    const applied: string[] = [];
    const failed: AccessReviewApplyFailure[] = [];
    let cursor: string | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's next
      const page = await options.reviews.items({
        review: reviewId,
        status: "revoked",
        ...(cursor === undefined ? {} : { cursor }),
      });
      const pending = page.items.filter((item) => item.appliedAt === undefined);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time bounds the concurrent block calls
      const causes = await Promise.all(
        pending.map((item) => applyItem(review, item)),
      );
      for (const [index, item] of pending.entries()) {
        const cause = causes[index];
        if (cause === undefined) applied.push(item.id);
        else failed.push({ item: item.id, cause });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return { applied, failed };
  };
}
