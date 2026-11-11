import type { RlsSqlContext } from "../sql/context.ts";
import type { Body } from "./helper-bodies.ts";

import { AUTHZ_VERSION_TABLE } from "../../supabase/sources.ts";
import { configError } from "../core/errors.ts";
import { scopeTypeOf } from "../sql/columns.ts";
import { stampHelpers } from "../sql/digest.ts";
import {
  hasMemberFor,
  hasMemberOf,
  permittedForHelper,
  permittedIdsHelper,
} from "../sql/names.ts";
import {
  bundleTableSql,
  policyBundle,
  POLICY_BUNDLE_TABLE,
  roleKeyMap,
} from "../sql/policy-bundle.ts";
import {
  helperSchema,
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { HELPERS, rootName } from "../sql/shared.ts";
import { keyTenantSql, subjectIdSql, userIdHelperSql } from "../sql/subject.ts";
import { hookTeamReadersSql } from "../supabase-hook/teams.ts";
import {
  apiKeyAllowsCall,
  apiKeyAllowsSql,
  ceilingHasSql,
  ceilingIdsSql,
  serviceKeyIdsSql,
} from "./api-keys.ts";
import { capabilitiesSql } from "./capabilities.ts";
import { customRoleByIdSql } from "./custom-role-by-id.ts";
import { customRoleCascadeSql } from "./custom-role-cascade.ts";
import { customRoleCompiledSql } from "./custom-role-compiled.ts";
import { customRoleNameGuardSql } from "./custom-role-guard.ts";
import { customRoleWritesSql } from "./custom-role-writes.ts";
import { customRolesSql, roleReadersSql } from "./custom-roles.ts";
import { globalRolesSql } from "./global-roles.ts";
import {
  functionBody,
  hasBody,
  memoHitList,
  memoizes,
  scopedBody,
  sqlBody,
} from "./helper-bodies.ts";
import {
  memberForFunction,
  memberFunction,
  memberOfFunction,
  memberRolesFunction,
} from "./helper-members.ts";
import {
  interactiveAllowsCall,
  interactiveAllowsSql,
  memoUserSql,
} from "./interactive-only.ts";
import { memoGenerationSql } from "./memo-generation.ts";
import { setHelpersSql } from "./set-helpers.ts";
import { tokenScopeAllowsCall, tokenScopeAllowsSql } from "./token-scopes.ts";

/** `'global'` or a scope name. */
export type HelperScope = string;

/**
 * One `role_permissions` row: `role` holds `grant_key`, which is `permission`
 * or `permission#n`.
 */
export type RolePermission = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: HelperScope;
  readonly effect: "allow" | "deny";
};

/**
 * The policy-side call for a grant key. Every form is uncorrelated, so Postgres
 * runs the helper once per statement (an InitPlan, or a hashed SubPlan for
 * `in`), never once per row.
 */
export function accessSql(
  ctx: RlsSqlContext,
  scope: HelperScope,
  grantKey: string,
  column: string | undefined,
  helper?: string,
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
  const fn = qualified(ctx, helper ?? permittedIdsHelper(scope));
  if (ctx.reuseMemo === true && memoizes(ctx)) {
    return `${quoteIdent(column)} in (${memoHitList(scope, key, `${fn}(${key})`, `${memoUserSql(ctx, subjectIdSql(ctx))}::text`, ctx.memo, scopeTypeOf(ctx, scope))})`;
  }
  return `${quoteIdent(column)} = any(array(select ${fn}(${key})))`;
}

/**
 * `permitted_<parent>_ids(p_grant)` for each \`rls.tables\` \`via\`: the parent
 * rows whose scope instance the grant reaches. \`security definer\`, so the
 * caller needs no read on the parent, and called uncorrelated like
 * \`permitted_<scope>_ids\`.
 */
function viaHelpersSql(ctx: RlsSqlContext, anonExecute: boolean): string[] {
  const done = new Set<string>();
  const chunks: string[] = [];
  for (const via of Object.values(ctx.vias ?? {})) {
    if (done.has(via.helper)) {
      continue;
    }
    done.add(via.helper);
    chunks.push(
      `-- rows of ${via.table} whose ${via.column} is a ${via.scope} the grant reaches
${helperFunction(
  ctx,
  via.helper,
  `setof ${via.type}`,
  sqlBody(
    `  select p.${quoteIdent(via.id)}
  from ${quoteQualified(via.table)} p
  where p.${quoteIdent(via.column)} = any(array(select ${qualified(ctx, permittedIdsHelper(via.scope))}(p_grant)))`,
  ),
  anonExecute,
)}`,
    );
  }
  return chunks;
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
parallel safe
set search_path = ''
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;
${grants}`;
}

function tokenCurrentSql(ctx: RlsSqlContext, anonExecute: boolean): string {
  const fn = qualified(ctx, HELPERS.tokenCurrent);
  const version = qualified(ctx, AUTHZ_VERSION_TABLE);
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `create or replace function ${fn}()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select to_jsonb(v.version) = (c.j -> 'authz_ver')
      and coalesce(c.j -> 'memberships_truncated', 'false'::jsonb) <> 'true'::jsonb
      and jsonb_typeof(c.j -> 'memberships') = 'array'
    from ${version} v
    cross join (select auth.jwt() as j) c
    where v.user_id = ${subjectIdSql(ctx)}
  ), false);
end;
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
${functionBody(body, !memoizes(ctx), returns.startsWith("setof"))}
${grants}`;
}

/**
 * `permdock_has_for(p_user, p_grant)` and one
 * `permitted_<scope>_ids_for(p_user, p_grant)` per scope in `database` mode:
 * the bodies of `permdock_has` and `permitted_<scope>_ids` with `p_user` for
 * the signed-in user and no tenant-claim narrowing, since a named user has no
 * token. For trusted SQL that acts for a stored user (jobs, triggers, approvals
 * resolved later). Naming the user is why no client role may execute them:
 * `security definer` callers run them as their owner, and a backend role needs
 * its own grant.
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
${functionBody(body, !memoizes(ctx), returns.startsWith("setof"))}
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
 * The `role_permissions` rows the policy compiles to: an upsert and a delete of
 * every other row. Data, not schema, so `supabase db diff` drops it from a
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

/**
 * `role_permissions` as a view over the compiled rows (`rls.seeds: 'view'`).
 * `security_invoker` makes the view read as its caller, so it adds no
 * privilege; the table's revoke applies to the view the same way.
 */
function seedViewSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
): string {
  const view = qualified(ctx, "role_permissions");
  const columns = "role, permission, grant_key, scope, effect";
  if (ctx.staticGrants === "ref") {
    return seedRefSql(ctx, rows);
  }
  const body =
    rows.length === 0
      ? `select null::text, null::text, null::text, null::text, null::text where false`
      : `select * from (values\n${rows
          .map(
            (row) =>
              `  (${[row.role, row.permission, row.grantKey, row.scope, row.effect].map(quoteLiteral).join(", ")})`,
          )
          .join(",\n")}\n) as v(${columns})`;
  const sorted = roleKeyMap(rows);
  const keys = qualified(ctx, "permdock_role_keys");
  return `-- rls.seeds: 'view': role_permissions is a view, so the rows travel with the schema
create or replace view ${view} (${columns}) with (security_invoker = true) as
${body};
revoke all on table ${view} from anon, authenticated, public;
-- the grant keys of each declared role per scope, as a hash lookup where the view's values list is scanned
create or replace function ${keys}(p_scope text, p_role text)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select ${quoteLiteral(JSON.stringify(sorted))}::jsonb -> p_scope -> p_role
$$;
revoke execute on function ${keys}(text, text) from public, anon, authenticated;`;
}

/**
 * `rls.staticGrants: 'ref'`: `role_permissions` is a view over the policy
 * bundle whose hash the SQL pins, and `permdock_role_keys` reads the bundle's
 * lookup. The rows are not in the SQL; \`permdock policy bundle --kind sql\`
 * loads them. A bundle that is not loaded, or is loaded under another hash,
 * leaves the view empty and the lookup null, so every static grant denies.
 */
function seedRefSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
): string {
  const { hash } = policyBundle(rows);
  const view = qualified(ctx, "role_permissions");
  const table = qualified(ctx, POLICY_BUNDLE_TABLE);
  const keys = qualified(ctx, "permdock_role_keys");
  const columns = "role, permission, grant_key, scope, effect";
  return `-- rls.staticGrants: 'ref': the static grants are the policy bundle ${hash}, loaded by permdock policy bundle
${bundleTableSql(ctx)}
create or replace view ${view} (${columns}) with (security_invoker = true) as
select r.role, r.permission, r.grant_key, r.scope, r.effect
from ${table} b
cross join lateral jsonb_to_recordset(b.doc -> 'rows') as r(role text, permission text, grant_key text, scope text, effect text)
where b.hash = ${quoteLiteral(hash)};
revoke all on table ${view} from anon, authenticated, public;
create or replace function ${keys}(p_scope text, p_role text)
returns jsonb
language sql
stable
parallel safe
set search_path = ''
as $$
  select b.doc -> 'roleKeys' -> p_scope -> p_role from ${table} b where b.hash = ${quoteLiteral(hash)}
$$;
revoke execute on function ${keys}(text, text) from public, anon, authenticated;`;
}

/**
 * `<schema>.seed()`: the same upsert and delete as `seedSql`, for a declarative
 * schema that carries no rows.
 */
function seedFunctionSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
): string {
  const fn = qualified(ctx, "seed");
  return `-- rls.seeds: 'function': the role_permissions rows are data, so a declarative diff leaves them out; run select ${fn}(); after each deploy
create or replace function ${fn}()
returns void
language sql
volatile
security definer
set search_path = ''
as $permdock$
${seedSql(ctx, rows)}
$permdock$;
revoke execute on function ${fn}() from public, anon, authenticated;`;
}

export type HelpersOptions = {
  /**
   * Emit a `user_roles` table for `database` mode; off when the RBAC scaffold
   * owns it.
   */
  readonly userRoles: boolean;
  /**
   * Let `anon` execute the helpers: a field view `anon` reads calls them, and
   * Postgres checks `execute` on every function in a view before it runs. They
   * find no subject for `anon` and return nothing.
   */
  readonly anonExecute?: boolean;
  /** Leave the `role_permissions` rows out: the `seeds` split part writes them. */
  readonly withoutSeeds?: boolean;
  /**
   * `[grant key, level]` pairs from `compileGrants`, for the custom-role
   * writes.
   */
  readonly levelReach?: readonly (readonly [string, string])[];
  /**
   * Every declared permission key, for `permdock_permission_keys`; the function
   * is left out without it.
   */
  readonly permissions?: readonly string[];
  readonly trustedReaders?: readonly string[];
};

/**
 * The one lookup from a role to its grant keys on a scope, which every helper
 * body reads through `cross join lateral`. It reads `role_permissions` as its
 * caller, as the join it replaces did, and pins `search_path` like every
 * helper. The pin keeps Postgres from inlining it, so each call is a primary
 * key range read of `role_permissions`.
 */
function roleGrantKeysSql(ctx: RlsSqlContext): string {
  const fn = qualified(ctx, HELPERS.roleGrantKeys);
  return `create or replace function ${fn}(p_scope text, p_role text)
returns setof text
language sql
stable
parallel safe
rows 10
set search_path = ''
as $$
  select rp.grant_key from ${qualified(ctx, "role_permissions")} rp where rp.role = p_role and rp.scope = p_scope
$$;
revoke execute on function ${fn}(text, text) from public, anon, authenticated;`;
}

/**
 * `role_permissions`, its seeds, and the three `security definer` helpers with
 * `search_path = ''`. `execute` goes to `authenticated` only.
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
    // The anon capability policies call permdock_capability_ids, which needs usage on its schema.
    const anonUsage = options.anonExecute === true || ctx.capabilities === true;
    chunks.push(
      `create schema if not exists ${s};\nrevoke all on schema ${s} from public;\ngrant usage on schema ${s} to ${anonUsage ? "anon, authenticated" : "authenticated"};`,
    );
  }
  if (ctx.dialect === "supabase") {
    chunks.push(userIdSql(ctx, options.anonExecute === true));
  }
  if (ctx.claimsFirst === true) {
    chunks.push(tokenCurrentSql(ctx, options.anonExecute === true));
  }
  if (ctx.seeds === "view") {
    chunks.push(seedViewSql(ctx, rows));
  } else {
    chunks.push(`create table if not exists ${rp} (
  role text not null,
  permission text not null,
  grant_key text not null,
  scope text not null check (scope ~ '^[a-z][a-z0-9_]*$'),
  effect text not null default 'allow' check (effect in ('allow', 'deny')),
  primary key (role, grant_key, scope)
);
alter table ${rp} enable row level security;
revoke all on table ${rp} from anon, authenticated, public;
${roleGrantKeysSql(ctx)}`);
  }
  if (ctx.seeds === "function") {
    chunks.push(seedFunctionSql(ctx, rows));
  } else if (options.withoutSeeds !== true && ctx.seeds !== "view") {
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
  const compiled = customRoleCompiledSql(ctx);
  if (compiled !== "") {
    chunks.push(compiled);
  }
  const memoGeneration = memoGenerationSql(ctx, memoReadsSql(ctx));
  if (memoGeneration !== "") {
    chunks.push(memoGeneration);
  }
  const anon = options.anonExecute === true;
  const keys = ctx.apiKeys;
  if (keys !== undefined) {
    chunks.push(apiKeyAllowsSql(ctx, keys, anon));
  }
  if (ctx.tokenScopes !== undefined) {
    chunks.push(tokenScopeAllowsSql(ctx, ctx.tokenScopes, anon));
  }
  if (ctx.interactiveOnly !== undefined) {
    chunks.push(interactiveAllowsSql(ctx, ctx.interactiveOnly, anon));
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
    chunks.push(setHelpersSql(ctx, scope.name, anon));
    chunks.push(memberFunction(ctx, scope.name, type, anon));
    if (ctx.roleMemberScopes?.includes(scope.name) === true) {
      chunks.push(memberRolesFunction(ctx, scope.name, type, anon));
    }
    if (hasMemberFor(ctx, scope.name)) {
      chunks.push(memberForFunction(ctx, scope.name, type));
    }
    if (hasMemberOf(ctx, scope.name)) {
      chunks.push(memberOfFunction(ctx, scope.name, type));
    }
  }
  const teamReaders = hookTeamReadersSql(ctx);
  if (teamReaders !== "") {
    chunks.push(teamReaders);
  }
  chunks.push(...viaHelpersSql(ctx, anon));
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
    const sync = ctx.customRoles?.sync;
    if (sync !== undefined) {
      chunks.push(sync);
    }
    const byId = customRoleByIdSql(ctx, options.trustedReaders);
    if (byId !== "") {
      chunks.push(byId);
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
  chunks.push(roleReadersSql(ctx, options.permissions, options.trustedReaders));
  return stampHelpers(`${chunks.join("\n\n")}\n`);
}

function memoBody(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  body: Body,
): Body {
  if (!memoizes(ctx)) {
    return body;
  }
  return {
    ...body,
    memo: {
      type,
      scope,
      user: memoUserSql(ctx, subjectIdSql(ctx)),
      ...(ctx.memo === undefined ? {} : { api: ctx.memo }),
    },
  };
}

export function memoReadsSql(ctx: RlsSqlContext): string {
  const bodies = grantBodies(ctx);
  return [
    bodies.has.sql,
    ...ctx.scopes.map((scope) => bodies.ids(scope.name).sql),
  ].join("\n");
}

export function grantBodies(ctx: RlsSqlContext): {
  readonly has: Body;
  readonly ids: (scope: string) => Body;
} {
  const keys = ctx.apiKeys;
  const scoped = ctx.tokenScopes !== undefined;
  const interactive = ctx.interactiveOnly !== undefined;
  const set = ctx.grantSet === true;
  const ceiling = (grant: string): string | undefined => {
    const calls = [
      ...(keys === undefined ? [] : [apiKeyAllowsCall(ctx, grant)]),
      ...(scoped ? [tokenScopeAllowsCall(ctx, grant)] : []),
      ...(interactive ? [interactiveAllowsCall(ctx, grant)] : []),
    ];
    return calls.length === 0 ? undefined : calls.join(" and ");
  };
  const allows = ceiling(set ? "ids.grant_key" : "p_grant");
  const keyTenant =
    keys === undefined ? "" : ` and ${keyTenantSql(ctx, undefined) ?? "true"}`;
  const hasAllows = ceiling(set ? "g.grant_key" : "p_grant");
  return {
    has: memoBody(
      ctx,
      "global",
      "boolean",
      sqlBody(
        hasAllows === undefined
          ? hasBody(ctx)
          : set
            ? `  select g.grant_key
  from (
${hasBody(ctx)}
  ) g(grant_key)
  where ${hasAllows}${keyTenant}`
            : ceilingHasSql(hasBody(ctx), `${hasAllows}${keyTenant}`),
      ),
    ),
    ids: (scope) => {
      const type = scopeTypeOf(ctx, scope);
      const body = scopedBody(ctx, scope, type);
      const sql =
        allows === undefined
          ? body.sql
          : keys !== undefined && scope === rootName(ctx)
            ? `${body.sql}\n  union\n${serviceKeyIdsSql(ctx, keys, scope, type)}`
            : body.sql;
      const wrapped =
        allows === undefined
          ? { sql, vars: body.vars }
          : {
              sql: set
                ? `  select ids.id, ids.grant_key
  from (
${sql}
  ) ids(id, grant_key)
  where ${allows}`
                : ceilingIdsSql(sql, allows),
              vars: body.vars,
            };
      return memoBody(ctx, scope, type, wrapped);
    },
  };
}

export function forUserContext(ctx: RlsSqlContext): RlsSqlContext {
  const {
    apiKeys: _apiKeys,
    tokenScopes: _tokenScopes,
    interactiveOnly: _interactiveOnly,
    claimsFirst: _claimsFirst,
    ...unkeyed
  } = ctx;
  return { ...unkeyed, subjectId: "p_user", tenants: "all" };
}
