import type { Membership, Principal } from "../core/subject.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";

/** A row of the better-supabase `memberships` table (organizations block), as `select user_id, organization_id, role, disabled_at` returns it. */
export type BetterSupabaseMembershipRow = {
  readonly user_id: string;
  readonly organization_id: string;
  readonly role: string;
  readonly disabled_at?: string | null;
};

export type PrincipalFromMembershipsOptions = {
  /** The policy scope an `organization_id` is an instance of; defaults to `tenant`, the first declared scope. */
  readonly scope?: string;
  /**
   * The organization the request acts in, the principal's active tenant. A
   * scoped grant applies only there; without it, pick one per request with
   * `permdock.tenant(id)`, or every scoped check denies with `no-tenant`.
   */
  readonly tenant?: string;
};

function isLiveRow(
  row: unknown,
  userId: string,
): row is BetterSupabaseMembershipRow {
  return (
    isRecord(row) &&
    row["user_id"] === userId &&
    typeof row["organization_id"] === "string" &&
    row["organization_id"] !== "" &&
    typeof row["role"] === "string" &&
    row["role"] !== "" &&
    (row["disabled_at"] === undefined || row["disabled_at"] === null)
  );
}

/**
 * The principal `userId` is in the better-supabase organizations block: one
 * membership per organization, keyed on `organization_id`, holding the role
 * of each of the user's rows. Rows of another user, disabled rows and
 * malformed rows are dropped, so a user with none holds no membership.
 */
export function principalFromMemberships(
  userId: string,
  rows: readonly BetterSupabaseMembershipRow[],
  options: PrincipalFromMembershipsOptions = {},
): Principal {
  const scope = options.scope ?? "tenant";
  const roles = new Map<string, string[]>();
  for (const row of rows) {
    if (!isLiveRow(row, userId)) {
      continue;
    }
    const held = roles.get(row.organization_id) ?? [];
    if (!held.includes(row.role)) {
      held.push(row.role);
    }
    roles.set(row.organization_id, held);
  }
  const memberships = [...roles].map(([id, names]): Membership => ({
    scope,
    id,
    roles: names,
  }));
  return freezeDeep(
    options.tenant === undefined
      ? { id: userId, memberships }
      : { id: userId, memberships, tenant: options.tenant },
  );
}
