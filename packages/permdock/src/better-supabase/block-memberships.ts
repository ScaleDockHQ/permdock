import type { BlockTables } from "better-supabase/contract";

import type { SqlQuery } from "../core/sql.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleThrough, SupabaseSuspension } from "../supabase/types.ts";

import { qualifySqlTable } from "../core/sql.ts";
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
  /**
   * `blockTables(config)` from `better-supabase/sql`: the memberships and
   * `membership_roles` tables with the app's `blocks.memberships.tables` and
   * `columns` renames. `table` and `columns` win over it.
   */
  readonly tables?: BlockTables;
  /**
   * The memberships block's table. Default the `tables` entry, else
   * `better_supabase.memberships`.
   */
  readonly table?: string;
  /** The declared scope a row is a membership of. Default `organization`. */
  readonly scope?: string;
  /**
   * Physical column names, keyed like better-supabase's
   * `blocks.memberships.columns.memberships`. Defaults the `tables` entry's
   * columns, else `organization_id`, `user_id`, `role` and `disabled_at`.
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
  /**
   * A role junction read instead of the role column. `"many"` reads the
   * `tables` entry for `membership_roles`, else `membership_roles` in the
   * table's schema: the role set `blocks.memberships.options.roles.many` keeps,
   * keyed by the tenant and user columns.
   */
  readonly roles?: BlockRoleJunction | "many";
  readonly query?: SqlQuery;
  readonly suspension?: SupabaseSuspension;
};

function roleOf(
  options: BlockMembershipSourceOptions,
  columns: {
    readonly table: string;
    readonly role: string;
    readonly tenant: string;
    readonly user: string;
  },
): string | RoleThrough {
  const column = columns.role;
  if (options.roles !== undefined && options.roleThrough !== undefined) {
    throw new TypeError(
      "PermDock: blockMembershipSource takes roles or roleThrough, not both; a junction holds role keys",
    );
  }
  if (options.roles === "many") {
    const junction = options.tables?.membershipRoles;
    return {
      through:
        junction?.table ??
        `${qualifySqlTable(columns.table).split(".")[0] ?? "better_supabase"}.membership_roles`,
      on: {
        [columns.tenant]: junction?.columns.tenant ?? columns.tenant,
        [columns.user]: junction?.columns.user ?? columns.user,
      },
      column: junction?.columns.role ?? "role",
    };
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
 * `roleThrough`, or several roles from a `roles` junction or, with `roles:
 * "many"`, from better-supabase's `membership_roles`. A row with `disabled_at`
 * set is no membership.
 */
export function blockMembershipSource(
  options: BlockMembershipSourceOptions = {},
): SqlMembershipSource {
  const c = options.columns ?? {};
  const block = options.tables?.memberships;
  const scope = options.scope ?? "organization";
  const disabled =
    c.disabledAt === undefined ? block?.columns.disabledAt : c.disabledAt;
  const disabledAt =
    disabled === null ? undefined : (disabled ?? "disabled_at");
  const table = options.table ?? block?.table ?? "better_supabase.memberships";
  const tenant = c.tenant ?? block?.columns.tenant ?? "organization_id";
  const user = c.user ?? block?.columns.user ?? "user_id";
  const role = c.role ?? block?.columns.role ?? "role";
  return junctionMembershipSource({
    table,
    scope,
    id: tenant,
    user,
    roles: roleOf(options, { table, role, tenant, user }),
    ...(disabledAt === undefined ? {} : { disabledAt }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.suspension === undefined
      ? {}
      : { suspension: options.suspension }),
  });
}
