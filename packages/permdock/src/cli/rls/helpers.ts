import type { RlsSqlContext } from "../sql/context.ts";

import { configError } from "../core/errors.ts";
import { scopeTypeOf } from "../sql/columns.ts";
import {
  hasMemberFor,
  permittedForHelper,
  permittedIdsHelper,
} from "../sql/names.ts";
import {
  helperSchema,
  qualified,
  quoteIdent,
  quoteLiteral,
} from "../sql/quote.ts";
import { HELPERS, rootName } from "../sql/shared.ts";
import { keyTenantSql, userIdHelperSql } from "../sql/subject.ts";
import {
  apiKeyAllowsCall,
  apiKeyAllowsSql,
  ceilingHasSql,
  ceilingIdsSql,
  serviceKeyIdsSql,
} from "./api-keys.ts";
import { capabilitiesSql } from "./capabilities.ts";
import { customRoleCascadeSql } from "./custom-role-cascade.ts";
import { customRoleNameGuardSql } from "./custom-role-guard.ts";
import { customRoleWritesSql } from "./custom-role-writes.ts";
import { customRolesSql, roleReadersSql } from "./custom-roles.ts";
import { globalRolesSql } from "./global-roles.ts";
import {
  type Body,
  functionBody,
  hasBody,
  scopedBody,
  sqlBody,
} from "./helper-bodies.ts";
import {
  memberForFunction,
  memberFunction,
  memberRolesFunction,
} from "./helper-members.ts";

/** `'global'` or a scope name. */
export type HelperScope = string;

/** One `role_permissions` row: `role` holds `grant_key`, which is `permission` or `permission#n`. */
export type RolePermission = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: HelperScope;
  readonly effect: "allow" | "deny";
};

/**
 * The policy-side call for a grant key. Every form is uncorrelated, so
 * Postgres runs the helper once per statement (an InitPlan, or a hashed
 * SubPlan for `in`), never once per row.
 */
export function accessSql(
  ctx: RlsSqlContext,
  scope: HelperScope,
  grantKey: string,
  column: string | undefined,
): string {
  const key = quoteLiteral(grantKey);
  if (scope === "global") {
    return `(select ${qualified(ctx, HELPERS.has)}(${key}))`;
  }
  if (column === undefined) {
    throw configError(
      `PermDock CLI: ${scope}-scoped grant needs definePolicy({ scopes.${scope} })`,
    );
  }
  return `${quoteIdent(column)} in (select ${qualified(ctx, permittedIdsHelper(scope))}(${key}))`;
}

function userIdSql(ctx: RlsSqlContext, anonExecute: boolean): string {
  const fn = userIdHelperSql(ctx);
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `-- the caller's user id: the sub of request.jwt.claims, or null when it is empty or absent
create or replace function ${fn}()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;
${grants}`;
}

function helperFunction(
  ctx: RlsSqlContext,
  name: string,
  returns: string,
  body: Body,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, name);
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  return `create or replace function ${fn}(p_grant text)
returns ${returns}
${functionBody(body)}
${grants}`;
}

/**
 * `permdock_has_for(p_user, p_grant)` and one
 * `permitted_<scope>_ids_for(p_user, p_grant)` per scope in `database` mode:
 * the bodies of `permdock_has` and `permitted_<scope>_ids` with `p_user` for
 * the signed-in user and no tenant-claim narrowing, since a named user has
 * no token. For trusted SQL that acts for a stored user (jobs, triggers,
 * approvals resolved later). Naming the user is why no client role may
 * execute them: `security definer` callers run them as their owner, and a
 * backend role needs its own grant.
 */
function forUserSql(ctx: RlsSqlContext): string {
  if (ctx.authorize !== "database") {
    return "";
  }
  const forUser = forUserContext(ctx);
  const type = ctx.dialect === "supabase" ? "uuid" : "text";
  const fn = (name: string, returns: string, body: Body): string => {
    const qualifiedName = qualified(ctx, name);
    return `create or replace function ${qualifiedName}(p_user ${type}, p_grant text)
returns ${returns}
${functionBody(body)}
revoke execute on function ${qualifiedName}(${type}, text) from public, anon, authenticated;`;
  };
  return [
    `-- the helpers for a user the caller names: trusted SQL acting for a stored user; no client role may execute them
${fn(HELPERS.hasFor, "boolean", sqlBody(hasBody(forUser)))}`,
    ...ctx.scopes.map((scope) => {
      const scopeType = scopeTypeOf(ctx, scope.name);
      return fn(
        permittedForHelper(scope.name),
        `setof ${scopeType}`,
        scopedBody(forUser, scope.name, scopeType),
      );
    }),
  ].join("\n\n");
}

function userIdType(ctx: RlsSqlContext): string {
  return ctx.dialect === "supabase"
    ? "uuid not null references auth.users on delete cascade"
    : "text not null";
}

/**
 * The `role_permissions` rows the policy compiles to: an upsert and a delete
 * of every other row. Data, not schema, so `supabase db diff` drops it from a
 * declarative schema; `--split ...,seeds` writes it as its own migration.
 */
export function seedSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
): string {
  const table = qualified(ctx, "role_permissions");
  if (rows.length === 0) {
    return `delete from ${table};`;
  }
  const values = rows
    .map(
      (row) =>
        `  (${[row.role, row.permission, row.grantKey, row.scope, row.effect].map(quoteLiteral).join(", ")})`,
    )
    .join(",\n");
  const keys = rows
    .map(
      (row) =>
        `  (${[row.role, row.grantKey, row.scope].map(quoteLiteral).join(", ")})`,
    )
    .join(",\n");
  return `insert into ${table} (role, permission, grant_key, scope, effect) values
${values}
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
delete from ${table}
where (role, grant_key, scope) not in (values
${keys}
);`;
}

export type HelpersOptions = {
  /** Emit a `user_roles` table for `database` mode; off when the RBAC scaffold owns it. */
  readonly userRoles: boolean;
  /**
   * Let `anon` execute the helpers: a field view `anon` reads calls them, and
   * Postgres checks `execute` on every function in a view before it runs. They
   * find no subject for `anon` and return nothing.
   */
  readonly anonExecute?: boolean;
  /** Leave the `role_permissions` rows out: the `seeds` split part writes them. */
  readonly withoutSeeds?: boolean;
  /** `[grant key, level]` pairs from `compileGrants`, for the custom-role writes. */
  readonly levelReach?: readonly (readonly [string, string])[];
  /** Every declared permission key, for `permdock_permission_keys`; the function is left out without it. */
  readonly permissions?: readonly string[];
  readonly trustedReaders?: readonly string[];
};

/**
 * `role_permissions`, its seeds, and the three `security definer` helpers
 * with `search_path = ''`. `execute` goes to `authenticated` only.
 */
export function helpersSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
  options: HelpersOptions,
): string {
  const schema = helperSchema(ctx);
  const s = quoteIdent(schema);
  const rp = qualified(ctx, "role_permissions");
  const chunks = [
    `-- permdock helpers (${ctx.authorize === "database" ? "database: reads the membership and user_roles tables" : "jwt: reads the role and memberships claims"})
-- policies call them uncorrelated, so Postgres evaluates each once per statement`,
  ];
  if (schema !== "public") {
    chunks.push(
      `create schema if not exists ${s};\nrevoke all on schema ${s} from public;\ngrant usage on schema ${s} to ${options.anonExecute === true ? "anon, authenticated" : "authenticated"};`,
    );
  }
  if (ctx.dialect === "supabase") {
    chunks.push(userIdSql(ctx, options.anonExecute === true));
  }
  chunks.push(`create table if not exists ${rp} (
  role text not null,
  permission text not null,
  grant_key text not null,
  scope text not null check (scope ~ '^[a-z][a-z0-9_]*$'),
  effect text not null default 'allow' check (effect in ('allow', 'deny')),
  primary key (role, grant_key, scope)
);
alter table ${rp} enable row level security;
revoke all on table ${rp} from anon, authenticated, public;`);
  if (options.withoutSeeds !== true) {
    chunks.push(seedSql(ctx, rows));
  }
  if (
    ctx.authorize === "database" &&
    options.userRoles &&
    ctx.roles === undefined
  ) {
    const ur = qualified(ctx, "user_roles");
    chunks.push(`create table if not exists ${ur} (
  user_id ${userIdType(ctx)},
  role text not null,
  primary key (user_id, role)
);
alter table ${ur} enable row level security;
revoke all on table ${ur} from anon, authenticated, public;`);
  }
  const custom = customRolesSql(ctx);
  if (custom !== "") {
    chunks.push(custom);
  }
  const anon = options.anonExecute === true;
  const keys = ctx.apiKeys;
  if (keys !== undefined) {
    chunks.push(apiKeyAllowsSql(ctx, keys, anon));
  }
  const bodies = grantBodies(ctx);
  chunks.push(helperFunction(ctx, HELPERS.has, "boolean", bodies.has, anon));
  const capabilities = capabilitiesSql(ctx);
  if (capabilities !== "") {
    chunks.push(capabilities);
  }
  for (const scope of ctx.scopes) {
    const type = scopeTypeOf(ctx, scope.name);
    chunks.push(
      helperFunction(
        ctx,
        permittedIdsHelper(scope.name),
        `setof ${type}`,
        bodies.ids(scope.name),
        anon,
      ),
    );
    chunks.push(memberFunction(ctx, scope.name, type, anon));
    if (ctx.roleMemberScopes?.includes(scope.name) === true) {
      chunks.push(memberRolesFunction(ctx, scope.name, type, anon));
    }
    if (hasMemberFor(ctx, scope.name)) {
      chunks.push(memberForFunction(ctx, scope.name, type));
    }
  }
  const forUser = forUserSql(ctx);
  if (forUser !== "") {
    chunks.push(forUser);
  }
  const writes = customRoleWritesSql(ctx, options.levelReach ?? []);
  if (writes !== "") {
    chunks.push(writes);
    const cascade = customRoleCascadeSql(ctx);
    if (cascade !== "") {
      chunks.push(cascade);
    }
    const nameGuard = customRoleNameGuardSql(ctx);
    if (nameGuard !== "") {
      chunks.push(nameGuard);
    }
  }
  const globalRoles = globalRolesSql(ctx);
  if (globalRoles !== "") {
    chunks.push(globalRoles);
  }
  const readers = roleReadersSql(
    ctx,
    options.permissions,
    options.trustedReaders,
  );
  if (readers !== "") {
    chunks.push(readers);
  }
  return `${chunks.join("\n\n")}\n`;
}

export function grantBodies(ctx: RlsSqlContext): {
  readonly has: Body;
  readonly ids: (scope: string) => Body;
} {
  const keys = ctx.apiKeys;
  const set = ctx.grantSet === true;
  const allows = apiKeyAllowsCall(ctx, set ? "ids.grant_key" : "p_grant");
  const keyTenant = keyTenantSql(ctx, undefined) ?? "true";
  return {
    has: sqlBody(
      keys === undefined
        ? hasBody(ctx)
        : set
          ? `  select g.grant_key
  from (
${hasBody(ctx)}
  ) g(grant_key)
  where ${apiKeyAllowsCall(ctx, "g.grant_key")} and ${keyTenant}`
          : ceilingHasSql(hasBody(ctx), `${allows} and ${keyTenant}`),
    ),
    ids: (scope) => {
      const type = scopeTypeOf(ctx, scope);
      const body = scopedBody(ctx, scope, type);
      if (keys === undefined) {
        return body;
      }
      const sql =
        scope === rootName(ctx)
          ? `${body.sql}\n  union\n${serviceKeyIdsSql(ctx, keys, scope, type)}`
          : body.sql;
      return {
        sql: set
          ? `  select ids.id, ids.grant_key
  from (
${sql}
  ) ids(id, grant_key)
  where ${allows}`
          : ceilingIdsSql(sql, allows),
        vars: body.vars,
      };
    },
  };
}

export function forUserContext(ctx: RlsSqlContext): RlsSqlContext {
  const { apiKeys: _apiKeys, ...unkeyed } = ctx;
  return { ...unkeyed, subjectId: "p_user", tenants: "all" };
}
