import type { PermDockConfig } from "../types.ts";
import type { Parts } from "./parts.ts";

import { type Scope, rootScope } from "../../core/scopes.ts";
import {
  AUTHZ_VERSION_TABLE,
  PERMDOCK_SCHEMA,
  supabaseMembershipsBudget,
  supabaseTenantClaim,
} from "../../supabase/sources.ts";
import { configError } from "../core/errors.ts";
import { authAdminRead, hookUri } from "../rls/rbac.ts";
import { beforeFirst } from "../shared/text.ts";
import { activeRowSql, checkSuspension } from "../sql/active.ts";
import { globalRoleSource } from "../sql/global-roles.ts";
import { memberForHelper } from "../sql/names.ts";
import {
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  quoteTable,
} from "../sql/quote.ts";
import {
  type ExtraClaim,
  attrsPlan,
  beforePlan,
  beforeSql,
  extraClaimsPlan,
  validateGrantsSql,
  validateSql,
} from "./claims.ts";
import {
  activeFromSql,
  checkSources,
  entriesSql,
  memberForPlan,
  positiveInteger,
  typedUsers,
} from "./memberships.ts";

const MANAGED_TRIGGER = "permdock_protect_managed";

export function hookSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  const rows = parts.roles;
  const roles =
    rows === undefined
      ? `  held := '[]'::jsonb;`
      : `  select coalesce(jsonb_agg(distinct ${rows.roleSql} order by ${rows.roleSql}) filter (where ${rows.roleSql} is not null), '[]'::jsonb)
    into held
    from ${rows.from}
    where ${rows.userSql} = v_roles_user;`;
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
  const dropTeams = parts.hook.teams === undefined ? "" : " - 'team_ids'";
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "uid")} then
    claims := claims - 'memberships_truncated' - 'attrs'${dropTeams} - ${quoteLiteral(parts.tenantClaim)}${dropExtra};
    claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);${version}
    return jsonb_set(event, '{claims}', claims);
  end if;`;
  const teamsConfig = parts.hook.teams;
  const teams =
    teamsConfig === undefined
      ? ""
      : `
  for team in
    select t.${quoteIdent(teamsConfig.team)}::text as id
    from ${quoteQualified(teamsConfig.table)} t
    where t.${quoteIdent(teamsConfig.user)} = uid
    order by ${teamsConfig.tenant === undefined ? "" : `(t.${quoteIdent(teamsConfig.tenant)}::text is not distinct from active) desc, `}t.${quoteIdent(teamsConfig.team)}
  loop
    if octet_length(kept::text) + used + octet_length((team_ids || to_jsonb(team.id))::text) > budget then
      truncated := true;
      exit;
    end if;
    team_ids := team_ids || jsonb_build_array(team.id);
  end loop;
  if team_ids <> '[]'::jsonb then
    claims := jsonb_set(claims, '{team_ids}', team_ids);
  end if;`;
  const create =
    parts.schema === "public"
      ? ""
      : `create schema if not exists ${schema};\nrevoke all on schema ${schema} from public;\n\n`;
  return `${create}create or replace function ${fn}(event jsonb)
returns jsonb
language plpgsql
stable
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
  used integer := 0;
  item record;${teamsConfig === undefined ? "" : "\n  team record;\n  team_ids jsonb := '[]'::jsonb;"}${typedUsers(parts)}${plan === undefined ? "" : "\n  attrs jsonb;"}${parts.extra.length === 0 ? "" : "\n  extra jsonb;"}${parts.version ? "\n  ver bigint;" : ""}${parts.before.length === 0 ? "" : "\n  checked jsonb;"}
begin${beforeSql(parts.before)}${suspended}
  claims := claims - 'attrs'${dropTeams}${dropExtra};
${roles}
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := ${parts.active.sql};${attrs}
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
${entriesSql(parts).replaceAll(/^/gmu, "      ")}
    ) x
    order by (x.tenant is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);${teams}
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, ${quoteLiteral(`{${parts.tenantClaim}}`)}, to_jsonb(active));
  end if;${extra}${version}${validateSql(parts)}
  return jsonb_set(event, '{claims}', claims);
end;
$$;`;
}

/** Everything the hook grants `supabase_auth_admin`, and the execute revoke. */
export function grantsSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  return [
    `-- supabase_auth_admin: the grants and read policies the hook needs
grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;${extraGrantsSql(parts.extra)}${beforeGrantsSql(parts.before, parts.extra)}${memberForGrantsSql(parts)}${validateGrantsSql(parts)}`,
    readsSql(parts),
    parts.version
      ? authAdminRead(`${parts.schema}.${AUTHZ_VERSION_TABLE}`, "version")
      : "",
  ]
    .filter((chunk) => chunk !== "")
    .join("\n");
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
  if (parts.hook.teams !== undefined) {
    reads.set(
      parts.hook.teams.table,
      reads.get(parts.hook.teams.table) ?? "teams",
    );
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
  "octet_length(memberships::text) + octet_length(attrs::text)";

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
  checkSources({ sources: hook.memberships, scopes });
  const parts: Parts = {
    schema,
    scopes,
    root,
    sources: hook.memberships,
    budget: positiveInteger(
      overrides.budget ?? hook.budget ?? supabaseMembershipsBudget,
      "budget",
    ),
    version: hook.version !== false,
    jwtExpiry: positiveInteger(hook.jwtExpiry ?? 900, "jwtExpiry"),
    tenantClaim,
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
        memberSources: config.rls?.membershipSources ?? hook.memberships,
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
