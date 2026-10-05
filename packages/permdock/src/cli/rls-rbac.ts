import type { Policy } from "../index.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type {
  PermDockConfig,
  RlsMemberships,
  RlsMembershipTable,
} from "./types.ts";

import { authorizeSql } from "../supabase/index.ts";
import { roleNames } from "./rls-grants.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "./rls-sql.ts";

export type RbacAuthorizeMode = "database" | "jwt";

export type RbacOptions = {
  /** Postgres schema for the enums, tables and functions. Default `permdock`. */
  readonly schema: string;
  /**
   * `database` reads `user_roles` (and the memberships table) on every statement: role changes
   * apply immediately. `jwt` reads the hook-injected claims: no query, stale until the token refreshes.
   */
  readonly authorize: RbacAuthorizeMode;
  readonly memberships?: RlsMembershipTable;
  /** The policy's first scope; `authorize(permission, tenant)` answers for an instance of it. */
  readonly scope?: string;
  /** Declared role names when custom roles compile; `authorize()` then answers from them too. */
  readonly customRoles?: {
    readonly declared: readonly string[];
    readonly levels?: true;
  };
  /** The helpers' context: `authorize()` reads its suspension tables. */
  readonly context?: RlsSqlContext;
};

export type RbacScaffold = {
  /** Enums and `user_roles`: emitted before the helpers, which read `user_roles`. */
  readonly head: string;
  /** `authorize()` and its grants. */
  readonly tail: string;
  readonly warnings: readonly string[];
};

/**
 * Where the helpers read roles and memberships: the flag, `rls.authorize`,
 * `rls.rbac.authorize`, then `database` with `rls.membershipSources`, with
 * `--rbac` or with a mapped memberships table, else `jwt`.
 */
export function resolveAuthorize(
  config: PermDockConfig,
  flags: {
    readonly authorize?: RbacAuthorizeMode | undefined;
    readonly rbac?: boolean;
    readonly memberships?: RlsMemberships | undefined;
  } = {},
): RbacAuthorizeMode {
  const rls = config.rls;
  const explicit = flags.authorize ?? rls?.authorize ?? rls?.rbac?.authorize;
  if (explicit !== undefined) {
    return explicit;
  }
  if (rls?.membershipSources !== undefined || flags.rbac === true) {
    return "database";
  }
  const memberships = flags.memberships ?? rls?.memberships;
  return memberships?.tenant !== undefined ||
    memberships?.team !== undefined ||
    Object.keys(memberships?.scopes ?? {}).length > 0
    ? "database"
    : "jwt";
}

export function parseRbacAuthorize(
  raw: string | undefined,
): RbacAuthorizeMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "database" || raw === "jwt") {
    return raw;
  }
  throw new Error(
    `PermDock CLI: --authorize must be database or jwt, got '${raw}'`,
  );
}

export function hookUri(schema: string): string {
  return `pg-functions://postgres/${schema}/custom_access_token_hook`;
}

function createEnum(
  schema: string,
  name: string,
  values: readonly string[],
): string {
  const list = values.map((value) => quoteLiteral(value)).join(", ");
  return `do $$ begin
  create type ${quoteTable(`${schema}.${name}`)} as enum (${list});
exception when duplicate_object then null;
end $$;`;
}

function hookTable(name: string): string {
  return quoteTable(name.includes(".") ? name : `public.${name}`);
}

/** A read policy and `select` grant for `supabase_auth_admin` on a table the hook reads. */
export function authAdminRead(table: string, label: string): string {
  const t = hookTable(table);
  const policy = quoteIdent(`permdock_auth_admin_read_${label}`);
  return `grant select on table ${t} to supabase_auth_admin;
drop policy if exists ${policy} on ${t};
create policy ${policy} on ${t}
  as permissive for select
  to supabase_auth_admin
  using (true);`;
}

/**
 * Supabase's Custom Claims and RBAC scaffold on top of the PermDock helpers:
 * enums, `user_roles` and `authorize()` over the shared `role_permissions`.
 * The token hook comes only from `permdock supabase hook generate`, so one
 * function writes the claims. Policies never call `authorize()` per row; they
 * call the helpers. Never grants anything to `service_role`.
 */
export function rbacScaffold(
  policy: Policy,
  options: RbacOptions,
): RbacScaffold {
  const schema = options.schema;
  const q = (name: string): string => quoteTable(`${schema}.${name}`);
  const s = quoteIdent(schema);
  const permissions = [
    ...new Set(policy.grants.map((grant) => grant.permission.key)),
  ];
  const authorizeFn = authorizeSql({
    schema,
    authorize: options.authorize,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.memberships === undefined
      ? {}
      : { tenant: options.memberships }),
    ...(options.customRoles === undefined
      ? {}
      : { customRoles: options.customRoles }),
    ...(options.context?.suspension === undefined
      ? {}
      : { suspension: options.context.suspension }),
  });
  const head = `-- rbac scaffold (Supabase Custom Claims and RBAC)
-- authorize: ${options.authorize}${options.authorize === "jwt" ? " (reads the hook claims; stale until the token refreshes)" : " (reads user_roles on every statement)"}
-- the custom access token hook that writes user_role${options.authorize === "jwt" ? " and memberships" : ""}: permdock supabase hook generate
${schema === "public" ? "" : `create schema if not exists ${s};\n`}${createEnum(schema, "app_role", roleNames(policy))}
${createEnum(schema, "app_permission", permissions)}

create table if not exists ${q("user_roles")} (
  user_id uuid not null references auth.users on delete cascade,
  role ${options.customRoles === undefined ? q("app_role") : "text"} not null,
  primary key (user_id, role)
);

alter table ${q("user_roles")} enable row level security;
revoke all on table ${q("user_roles")} from authenticated, anon, public;
`;
  return { head, tail: authorizeFn, warnings: [] };
}
