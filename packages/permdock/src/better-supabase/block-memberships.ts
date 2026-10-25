import type { SqlQuery } from "../core/sql.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleThrough, SupabaseSuspension } from "../supabase/types.ts";

import { junctionMembershipSource } from "../supabase/sources.ts";

/**
 * A roles table the membership's role column references, in better-supabase's
 * `blocks.memberships.options.roleThrough` shape: the role column holds
 * `table.id`, and `table.column` holds the role key.
 */
export type BlockRoleThrough = {
  readonly table: string;
  readonly id: string;
  readonly column: string;
};

/**
 * A role junction holding several roles per membership: one row per role,
 * `membership` referencing the membership's `id` column and `role` holding the
 * role key.
 */
export type BlockRoleJunction = {
  readonly table: string;
  /** The junction column referencing the membership. */
  readonly membership: string;
  /** The junction column holding the role key. */
  readonly role: string;
  /** The membership's primary key column. Default `id`. */
  readonly id?: string;
};

export type BlockMembershipSourceOptions = {
  /** The memberships block's table. Default `better_supabase.memberships`. */
  readonly table?: string;
  /** The declared scope a row is a membership of. Default `organization`. */
  readonly scope?: string;
  /**
   * Physical column names, keyed like better-supabase's
   * `blocks.memberships.columns.memberships`. Defaults `organization_id`,
   * `user_id`, `role` and `disabled_at`.
   */
  readonly columns?: {
    readonly tenant?: string;
    readonly user?: string;
    readonly role?: string;
    readonly disabledAt?: string | null;
  };
  /**
   * The roles table the role column references, so a custom role's key reads
   * through it. The same value as `blocks.memberships.options.roleThrough`.
   */
  readonly roleThrough?: BlockRoleThrough;
  /** A role junction read instead of the role column. */
  readonly roles?: BlockRoleJunction;
  readonly query?: SqlQuery;
  readonly suspension?: SupabaseSuspension;
};

function roleOf(
  options: BlockMembershipSourceOptions,
  column: string,
): string | RoleThrough {
  if (options.roles !== undefined && options.roleThrough !== undefined) {
    throw new TypeError(
      "PermDock: blockMembershipSource takes roles or roleThrough, not both; a junction holds role keys",
    );
  }
  if (options.roles !== undefined) {
    return {
      through: options.roles.table,
      on: { [options.roles.id ?? "id"]: options.roles.membership },
      column: options.roles.role,
    };
  }
  if (options.roleThrough !== undefined) {
    return {
      through: options.roleThrough.table,
      on: { [column]: options.roleThrough.id },
      column: options.roleThrough.column,
    };
  }
  return column;
}

/**
 * Memberships from better-supabase's `memberships` block table: one row per
 * user and organization, its role key in `role`, a custom role's key through
 * `roleThrough`, or several roles from a `roles` junction. A row with
 * `disabled_at` set is no membership.
 */
export function blockMembershipSource(
  options: BlockMembershipSourceOptions = {},
): SqlMembershipSource {
  const c = options.columns ?? {};
  const scope = options.scope ?? "organization";
  const disabledAt =
    c.disabledAt === null ? undefined : (c.disabledAt ?? "disabled_at");
  return junctionMembershipSource({
    table: options.table ?? "better_supabase.memberships",
    scope,
    id: c.tenant ?? "organization_id",
    user: c.user ?? "user_id",
    roles: roleOf(options, c.role ?? "role"),
    ...(disabledAt === undefined ? {} : { disabledAt }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.suspension === undefined
      ? {}
      : { suspension: options.suspension }),
  });
}
