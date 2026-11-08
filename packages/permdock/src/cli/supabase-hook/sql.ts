import type { Scope } from "../../core/scopes.ts";
import type { PermDockConfig } from "../types.ts";
import type { ExtraClaim } from "./claims.ts";
import type { Parts } from "./parts.ts";

import { rootScope } from "../../core/scopes.ts";
import { AUTHZ_TOPIC } from "../../supabase/authz-topic.ts";
import { CUSTOM_ROLES_VERSION_CLAIM } from "../../supabase/budget.ts";
import {
  AUTHZ_VERSION_TABLE,
  PERMDOCK_SCHEMA,
  supabaseMembershipsBudget,
  supabaseTenantClaim,
} from "../../supabase/sources.ts";
import { configError } from "../core/errors.ts";
import { authAdminRead, hookUri, resolveAuthorize } from "../rls/rbac.ts";
import { beforeFirst } from "../shared/text.ts";
import { activeRowSql, checkSuspension } from "../sql/active.ts";
import { firstScopeType, sqlType } from "../sql/columns.ts";
import { globalRoleSource } from "../sql/global-roles.ts";
import { memberForHelper } from "../sql/names.ts";
import {
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  quoteTable,
} from "../sql/quote.ts";
import { customRolesOn } from "../sql/shared.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import {
  attrsPlan,
  beforePlan,
  beforeSql,
  extraClaimsPlan,
  validateGrantsSql,
  validateSql,
} from "./claims.ts";
import {
  MEMBERSHIPS_FOR,
  entriesGrantsSql,
  entryTenantSql,
} from "./entries.ts";
import {
  activeFromSql,
  activeSource,
  checkSources,
  hookMemberships,
  memberForPlan,
  positiveInteger,
  typedUsers,
} from "./memberships.ts";

const MANAGED_TRIGGER = "permdock_protect_managed";

export function schemaSql(parts: Parts): string {
  if (parts.schema === "public") {
    return "";
  }
  const schema = quoteIdent(parts.schema);
  return `create schema if not exists ${schema};\nrevoke all on schema ${schema} from public;`;
}

export function hookSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  const plan = parts.attrs;
  const tableMembershipSource =
    plan === undefined || plan.columns.length === 0 || plan.table === undefined
      ? ""
      : `
  select jsonb_strip_nulls(jsonb_build_object(${plan.columns
    .map(
      (column) => `${quoteLiteral(column)}, to_jsonb(p.${quoteIdent(column)})`,
    )
    .join(", ")}))
    into attrs
    from ${quoteQualified(plan.table)} p
    where p.${quoteIdent(plan.id)} = v_attrs_user;`;
  const fromMeta =
    plan === undefined || plan.meta.length === 0
      ? ""
      : `
  attrs := coalesce(attrs, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(${plan.meta
    .map(
      (key) =>
        `${quoteLiteral(key)}, claims -> 'app_metadata' -> ${quoteLiteral(key)}`,
    )
    .join(", ")}));`;
  const attrs =
    plan === undefined
      ? ""
      : `${tableMembershipSource}${fromMeta}
  if attrs is not null and attrs <> '{}'::jsonb then
    used := octet_length(attrs::text);
    if used > budget then
      truncated := true;
      used := 0;
    else
      claims := jsonb_set(claims, '{attrs}', attrs);
    end if;
  end if;`;
  const versionTable = `${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)}`;
  const version = parts.version
    ? `
  select v.version into ver from ${versionTable} v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));`
    : "";
  const versionClaim = parts.version
    ? `
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(ver));`
    : "";
  const customVersion =
    parts.customRoles === undefined
      ? ""
      : `
    claims := jsonb_set(claims, ${quoteLiteral(`{${CUSTOM_ROLES_VERSION_CLAIM}}`)}, to_jsonb(${schema}.custom_roles_version_for(active::${parts.customRoles.tenantType})));`;
  const dropCustom =
    parts.customRoles === undefined
      ? ""
      : ` - ${quoteLiteral(CUSTOM_ROLES_VERSION_CLAIM)}`;
  const dropExtra = parts.extra
    .map((entry) => ` - ${quoteLiteral(entry.claim)}`)
    .join("");
  const extra = parts.extra
    .map(
      (entry) => `
  extra := ${quoteTable(entry.fn)}(uid);
  if extra is not null then
    claims := jsonb_set(claims, ${quoteLiteral(`{${entry.claim}}`)}, extra);
  end if;`,
    )
    .join("");
  const dropTeams =
    parts.hook.teams === undefined
      ? ""
      : " - 'team_ids' - 'team_ids_truncated'";
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "uid")} then
    claims := claims - 'memberships_truncated' - 'attrs'${dropTeams} - ${quoteLiteral(parts.tenantClaim)}${dropCustom}${dropExtra};
    claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);${version}
    return jsonb_set(event, '{claims}', claims);
  end if;`;
  const teamsConfig = parts.hook.teams;
  const teams =
    teamsConfig === undefined
      ? ""
      : `
  -- the teams share the budget with the roles, the attrs, the version and the memberships already kept
  if used + octet_length(kept::text) + octet_length(team_ids::text) > budget then
    team_truncated := true;
  end if;
  if team_truncated then
    claims := jsonb_set(claims, '{team_ids_truncated}', 'true'::jsonb);
  else
    claims := claims - 'team_ids_truncated';
    if team_ids <> '[]'::jsonb then
      claims := jsonb_set(claims, '{team_ids}', team_ids);
    end if;
  end if;`;
  const schemaName = quoteIdent(parts.schema);
  const rolesCte =
    parts.roles === undefined
      ? "select '[]'::jsonb as held"
      : `select ${schemaName}.global_roles_for(uid) as held`;
  const versionCte = parts.version
    ? `,
    pdk_version as (
      select coalesce((select v.version from ${versionTable} v where v.user_id = uid), 0) as ver
    )`
    : "";
  const teamsCte =
    teamsConfig === undefined
      ? ""
      : `,
    pdk_teams as (
      select coalesce(jsonb_agg(to_jsonb(u.id::text) order by u.n), '[]'::jsonb) as team_ids
      from unnest(array(
        select team_id from ${schemaName}.member_team_ids_for(uid, active) as team(team_id)
      )) with ordinality as u(id, n)
    )`;
  // user_role repeats the roles (the one role, or the list), and the tenant claim is written whenever a membership is in the active tenant: both count.
  const userRoleBytes =
    "octet_length(case jsonb_array_length(pdk_roles.held) when 0 then '' when 1 then (pdk_roles.held -> 0)::text else pdk_roles.held::text end)";
  const fixed = `used + octet_length(pdk_roles.held::text) + ${userRoleBytes} + coalesce(octet_length(to_jsonb(active)::text), 0)${parts.customRoles === undefined ? "" : " + 20"}${parts.version ? " + octet_length(pdk_version.ver::text)" : ""}`;
  const fixedFrom = `pdk_roles${parts.version ? ", pdk_version" : ""}`;
  const oneQuery = `  -- one statement reads the roles, the memberships${teamsConfig === undefined ? "" : ", the teams"}${parts.version ? " and the authorization version" : ""}; the budget counts every slice
  with pdk_roles as (
      ${rolesCte}
    )${versionCte}${teamsCte},
    pdk_entries as (
      select e.ord, e.entry, ${entryTenantSql(parts, "e")} as root_id
      from ${schemaName}.${MEMBERSHIPS_FOR}(uid) e
    ),
    pdk_fixed as (
      select ${fixed} as bytes from ${fixedFrom}
    ),
    pdk_ranked as (
      select x.entry, x.root_id is not distinct from active as current,
        row_number() over w as n,
        sum(octet_length(x.entry::text)) over w as bytes
      from pdk_entries x
      window w as (
        order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
        rows between unbounded preceding and current row
      )
    ),
    pdk_kept as (
      select r.* from pdk_ranked r, pdk_fixed f where f.bytes + 2 + r.bytes + 2 * (r.n - 1) <= budget
    )
  select
    (select pdk_roles.held from pdk_roles),
    coalesce((select jsonb_agg(k.entry order by k.n) from pdk_kept k), '[]'::jsonb),
    truncated or (select count(*) from pdk_ranked) > (select count(*) from pdk_kept),
    active is not null and coalesce((select bool_or(k.current) from pdk_ranked k), false),
    (select bytes from pdk_fixed)${teamsConfig === undefined ? "" : ",\n    (select pdk_teams.team_ids from pdk_teams)"}${parts.version ? ",\n    (select pdk_version.ver from pdk_version)" : ""}
  into held, kept, truncated, in_active, used${teamsConfig === undefined ? "" : ", team_ids"}${parts.version ? ", ver" : ""};
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  claims := jsonb_set(claims, '{memberships}', kept);`;
  return `create or replace function ${fn}(event jsonb)
returns jsonb
language plpgsql
stable${parts.hook.security === "definer" ? "\nsecurity definer" : ""}
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  uid uuid := (event ->> 'user_id')::uuid;
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := ${String(parts.budget)};
  used integer := 0;${teamsConfig === undefined ? "" : "\n  team_ids jsonb := '[]'::jsonb;\n  team_truncated boolean := false;"}${typedUsers(parts)}${plan === undefined ? "" : "\n  attrs jsonb;"}${parts.extra.length === 0 ? "" : "\n  extra jsonb;"}${parts.version ? "\n  ver bigint;" : ""}${parts.before.length === 0 ? "" : "\n  checked jsonb;"}
begin${beforeSql(parts.before)}${suspended}
  claims := claims - 'attrs'${dropTeams}${dropCustom}${dropExtra};
  active := ${parts.active.sql};${attrs}
${oneQuery}${teams}
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, ${quoteLiteral(`{${parts.tenantClaim}}`)}, to_jsonb(active));${customVersion}
  end if;${extra}${versionClaim}${validateSql(parts)}
  return jsonb_set(event, '{claims}', claims);
end;
$$;`;
}

/** Everything the hook grants `supabase_auth_admin`, and the execute revoke. */
export function grantsSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  if (parts.hook.security === "definer") {
    return `-- supabase_auth_admin: execute only; the hook reads with its owner's rights
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;
grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;${extraRevokesSql(parts.extra, parts.before)}`;
  }
  return [
    `-- supabase_auth_admin: the grants and read policies the hook needs
grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;${extraGrantsSql(parts.extra)}${beforeGrantsSql(parts.before, parts.extra)}${customRolesGrantsSql(parts)}${entriesGrantsSql(parts)}${memberForGrantsSql(parts)}${validateGrantsSql(parts)}`,
    readsSql(parts),
    parts.version
      ? authAdminRead(`${parts.schema}.${AUTHZ_VERSION_TABLE}`, "version")
      : "",
  ]
    .filter((chunk) => chunk !== "")
    .join("\n");
}

/**
 * The hook reads the active tenant's custom-role version through the definer
 * function.
 */
function customRolesGrantsSql(parts: Parts): string {
  return parts.customRoles === undefined
    ? ""
    : `\ngrant execute on function ${quoteIdent(parts.schema)}.custom_roles_version_for(${parts.customRoles.tenantType}) to supabase_auth_admin;`;
}

/**
 * A definer hook calls `hook.claims` and `hook.before` functions as its owner,
 * so they need no grant; they are still revoked from the client roles.
 */
function extraRevokesSql(
  extra: readonly ExtraClaim[],
  before: readonly string[],
): string {
  return [
    ...extra.map(
      (entry) =>
        `\nrevoke all on function ${quoteTable(entry.fn)}(uuid) from public, anon, authenticated;`,
    ),
    ...before.map(
      (fn) =>
        `\nrevoke all on function ${quoteTable(fn)}(jsonb) from public, anon, authenticated;`,
    ),
  ].join("");
}

function extraGrantsSql(extra: readonly ExtraClaim[]): string {
  const schemas = [...new Set(extra.map((entry) => entry.fn.split(".")[0]))];
  return [
    ...schemas.map(
      (name) =>
        `\ngrant usage on schema ${quoteIdent(name ?? "")} to supabase_auth_admin;`,
    ),
    ...extra.map(
      (entry) =>
        `\nrevoke all on function ${quoteTable(entry.fn)}(uuid) from public, anon, authenticated;\ngrant execute on function ${quoteTable(entry.fn)}(uuid) to supabase_auth_admin;`,
    ),
  ].join("");
}

function beforeGrantsSql(
  before: readonly string[],
  extra: readonly ExtraClaim[],
): string {
  const granted = new Set(extra.map((entry) => entry.fn.split(".")[0]));
  const schemas = [...new Set(before.map((fn) => beforeFirst(fn, ".")))].filter(
    (name) => !granted.has(name),
  );
  return [
    ...schemas.map(
      (name) =>
        `\ngrant usage on schema ${quoteIdent(name)} to supabase_auth_admin;`,
    ),
    ...before.map(
      (fn) =>
        `\nrevoke all on function ${quoteTable(fn)}(jsonb) from public, anon, authenticated;\ngrant execute on function ${quoteTable(fn)}(jsonb) to supabase_auth_admin;`,
    ),
  ].join("");
}

/**
 * Execute on each `member_<scope>_ids_for(uuid)` for the `hook.claims`
 * functions, which run as `supabase_auth_admin` and may call them. Only with
 * `hook.claims`: the grant needs the helpers migration applied first, and a
 * hook without extra claims does not.
 */
function memberForGrantsSql(parts: Parts): string {
  const { schema, memberFor } = parts.helpers;
  if (memberFor.length === 0 || parts.extra.length === 0) {
    return "";
  }
  return [
    ...(schema === parts.schema
      ? []
      : [
          `\ngrant usage on schema ${quoteIdent(schema)} to supabase_auth_admin;`,
        ]),
    ...memberFor.map(
      (scope) =>
        `\ngrant execute on function ${quoteIdent(schema)}.${memberForHelper(scope)}(uuid) to supabase_auth_admin;`,
    ),
  ].join("");
}

function readsSql(parts: Parts): string {
  const reads = new Map<string, string>();
  for (const source of parts.sources) {
    reads.set(source.sql.table, "memberships");
  }
  for (const source of parts.sources) {
    for (const name of source.sql.reads) {
      reads.set(name, reads.get(name) ?? "status");
    }
    for (const through of source.sql.throughs) {
      reads.set(through.table, reads.get(through.table) ?? "role_keys");
    }
    const users = source.sql.userThrough;
    if (users !== undefined) {
      reads.set(users.table, reads.get(users.table) ?? "member_users");
    }
  }
  if (parts.roles !== undefined) {
    const { table: rolesTable, through } = parts.roles;
    reads.set(rolesTable, reads.get(rolesTable) ?? "roles");
    if (through !== undefined) {
      reads.set(through.table, reads.get(through.table) ?? "role_keys");
    }
  }
  if (parts.attrs?.table !== undefined && parts.attrs.columns.length > 0) {
    reads.set(parts.attrs.table, reads.get(parts.attrs.table) ?? "attrs");
  }
  if (parts.users !== undefined) {
    reads.set(
      parts.users.table,
      reads.get(parts.users.table) ?? "status_users",
    );
  }
  const schemas = new Set(
    [...reads.keys()]
      .map((name) => (name.includes(".") ? name.split(".")[0] : "public"))
      .filter(
        (schema): schema is string =>
          schema !== undefined && schema !== parts.schema && schema !== "auth",
      ),
  );
  return [
    ...[...schemas].map(
      (schema) =>
        `grant usage on schema ${quoteIdent(schema)} to supabase_auth_admin;`,
    ),
    ...[...reads].map(([name, label]) => authAdminRead(name, label)),
  ].join("\n");
}

export function managedSql(parts: Parts): string {
  const managed = parts.sources.filter(
    (source) => source.sql.managed !== undefined,
  );
  if (managed.length === 0) {
    return "";
  }
  const schema = quoteIdent(parts.schema);
  const guard = `${schema}.permdock_protect_managed`;
  const triggers = managed
    .map(
      (
        source,
      ) => `drop trigger if exists ${quoteIdent(MANAGED_TRIGGER)} on ${quoteQualified(source.sql.table)};
create trigger ${quoteIdent(MANAGED_TRIGGER)}
  before insert or update or delete on ${quoteQualified(source.sql.table)}
  for each row execute function ${guard}(${quoteLiteral(source.sql.managed ?? "")});`,
    )
    .join("\n");
  return `-- memberships the identity provider owns: clients (anon, authenticated) cannot write them
create or replace function ${guard}()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
begin
  if current_user in ('anon', 'authenticated') and (
    column_name = ''
    or (tg_op <> 'INSERT' and to_jsonb(old) ->> column_name = 'idp')
    or (tg_op <> 'DELETE' and to_jsonb(new) ->> column_name = 'idp')
  ) then
    raise exception 'PermDock: % rows managed by the identity provider cannot be changed here', tg_table_name
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
${triggers}`;
}

/** The `config.toml` block that enables the hook and bounds token staleness. */
export function configToml(schema: string, jwtExpiry: number): string {
  return `[auth]
jwt_expiry = ${String(jwtExpiry)}

[auth.hook.custom_access_token]
enabled = true
uri = "${hookUri(schema)}"`;
}

export const BUDGET_MEASURE =
  "octet_length(roles::text) + octet_length(memberships::text) + octet_length(team_ids::text) + octet_length(attrs::text) + octet_length(authz_ver::text)";

export type HookOverrides = {
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly schema?: string;
};

export function hookParts(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides,
): Parts {
  const hook = config.supabase?.hook;
  if (hook === undefined) {
    throw configError(
      "PermDock CLI: supabase hook generate needs supabase.hook in permdock.config.ts",
    );
  }
  const root = rootScope(scopes) ?? "tenant";
  const suspension = checkSuspension(
    hook.suspension ?? config.rls?.suspension,
    scopes,
  );
  const schema =
    overrides.schema ?? hook.schema ?? config.rls?.schema ?? PERMDOCK_SCHEMA;
  quoteIdent(schema);
  const tenantClaim = config.rls?.tenantClaim ?? supabaseTenantClaim;
  const extraPlan = extraClaimsPlan(hook.claims, tenantClaim);
  const sources = hookMemberships(
    hook.memberships,
    config.rls?.memberships,
    scopes,
  );
  checkSources({ sources, scopes });
  const parts: Parts = {
    schema,
    scopes,
    root,
    sources,
    budget: positiveInteger(
      overrides.budget ?? hook.budget ?? supabaseMembershipsBudget,
      "budget",
    ),
    version: hook.version !== false,
    broadcast:
      hook.version === false || hook.broadcast === false
        ? undefined
        : {
            topic: hook.broadcast?.topic ?? AUTHZ_TOPIC,
            receivePolicy: hook.broadcast?.receivePolicy ?? true,
          },
    jwtExpiry: positiveInteger(hook.jwtExpiry ?? 900, "jwtExpiry"),
    tenantClaim,
    customRoles:
      customRolesOn(config.rls) && resolveAuthorize(config) === "database"
        ? {
            tenantType: sqlType(firstScopeType(config.rls?.scopeTypes, scopes)),
          }
        : undefined,
    users: suspension?.users,
    hook,
    roles:
      hook.roles === false
        ? undefined
        : globalRoleSource(
            hook.roles ??
              config.rls?.roles ?? { table: `${schema}.user_roles` },
            "public",
            "r",
            config.rls?.customRoleWrites?.roles,
          ),
    active: activeFromSql(overrides.activeFrom ?? hook.activeFrom, root),
    activeFrom: activeSource(overrides.activeFrom ?? hook.activeFrom, root),
    attrs: hook.attrs === undefined ? undefined : attrsPlan(hook.attrs),
    extra: extraPlan.claims,
    before: beforePlan(hook.before),
    helpers: {
      schema: config.rls?.schema ?? PERMDOCK_SCHEMA,
      ...memberForPlan({
        scopes,
        ...(config.rls?.memberships === undefined
          ? {}
          : { memberships: config.rls.memberships }),
        memberSources: membershipSourcesOf(config),
      }),
    },
  };
  if (parts.attrs !== undefined && parts.attrs.errors.length > 0) {
    throw configError(`PermDock CLI: ${parts.attrs.errors.join("; ")}`);
  }
  if (extraPlan.errors.length > 0) {
    throw configError(`PermDock CLI: ${extraPlan.errors.join("; ")}`);
  }
  quoteIdent(parts.tenantClaim);
  return parts;
}
