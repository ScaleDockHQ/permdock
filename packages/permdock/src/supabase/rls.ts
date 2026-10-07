import type {
  AuthorizeSqlOptions,
  SupabaseActiveRow,
  SupabaseMembershipTable,
  SupabaseRlsConfig,
  SupabaseRlsOptions,
  SupabaseSuspension,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { quoteSqlIdent, quoteSqlLiteral, quoteSqlTable } from "../core/sql.ts";
import { supabaseTenantClaim } from "./budget.ts";
import { keptKeys } from "./keep.ts";
import { type RoleColumn, roleColumn } from "./roles.ts";
import { PERMDOCK_SCHEMA } from "./sources.ts";

function isTable(
  value: unknown,
): value is SupabaseRlsOptions["memberships"] & { readonly table: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "table" in value &&
    typeof value.table === "string"
  );
}

export function supabaseRls(
  options: SupabaseRlsOptions = {},
): SupabaseRlsConfig {
  const raw = options.memberships;
  const memberships =
    raw === undefined ? undefined : isTable(raw) ? { tenant: raw } : raw;
  return compact<SupabaseRlsConfig>({
    dialect: "supabase",
    roleClaim: options.roleClaim ?? "user_role",
    tenantClaim: options.tenantClaim ?? supabaseTenantClaim,
    tenantType: options.tenantType,
    memberships,
    suspension: options.suspension,
  });
}

const ident = (name: string): string => quoteSqlIdent(name);
const table = (name: string): string => quoteSqlTable(name);
const literal = quoteSqlLiteral;

// `authorize()` runs with `search_path = ''`, so a bare table name must be qualified.
function qualifiedTable(name: string): string {
  return table(name.includes(".") ? name : `public.${name}`);
}

/** The memberships table's role key over alias `m`, joined to its roles table when it holds a reference. */
function tenantRole(memberships: SupabaseMembershipTable): RoleColumn {
  return roleColumn(
    memberships.role,
    memberships.table.includes(".")
      ? memberships.table
      : `public.${memberships.table}`,
    "m",
    { label: "authorizeSql tenant.role", indent: "      " },
  );
}

function textArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(literal).join(", ")}]::text[]`;
}

function activeRow(row: SupabaseActiveRow, id: string, text = false): string {
  const parts = [`s.${ident(row.id)}${text ? "::text" : ""} = ${id}`];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${ident(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    if (row.active === undefined || row.active.length === 0) {
      throw new TypeError(
        "PermDock: a suspension status column needs its active values",
      );
    }
    parts.push(`s.${ident(row.status)}::text = any(${textArray(row.active)})`);
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw new TypeError(
      "PermDock: a suspension table needs disabledAt or status",
    );
  }
  return `exists (select 1 from ${qualifiedTable(row.table)} s where ${parts.join(" and ")})`;
}

/**
 * Early `return false` for a suspended user, or a tenant request for a
 * suspended instance unless its scope keeps the requested permission.
 */
function suspendedGuards(
  suspension: SupabaseSuspension | undefined,
  scope: string,
  uid: string,
): string {
  const lines: string[] = [];
  const users = suspension?.users;
  if (users !== undefined) {
    lines.push(`  if not ${activeRow(users, uid)} then
    return false; -- suspended user
  end if;`);
  }
  const tenant = suspension?.scopes?.[scope];
  if (tenant !== undefined) {
    const keep = keptKeys(tenant);
    const kept =
      keep.length === 0
        ? ""
        : ` and not (requested_permission::text = any(${textArray(keep)}))`;
    lines.push(`  if requested_tenant is not null and not ${activeRow(tenant, "requested_tenant", true)}${kept} then
    return false; -- suspended ${scope}
  end if;`);
  }
  return lines.map((line) => `\n${line}`).join("");
}

function claimEntries(where: string, value: string): string {
  return `array(select ${value} from jsonb_array_elements_text(cg.g) e where ${where})`;
}

/** A custom role's keys hold `requested_permission` in the first scope. */
function customHolds(
  q: (name: string) => string,
  scope: string,
  allows: string,
  denies: string,
  includes: string,
): string {
  return `exists (
          select 1 from ${q("role_permissions")} rp
          where rp.permission = requested_permission::text
            and rp.scope = ${literal(scope)}
            and rp.effect = 'allow'
            and rp.grant_key in (select ${q("permdock_custom_keys")}(
              ${allows},
              ${denies},
              ${includes},
              ${literal(scope)}
            ))
        )`;
}

function customDatabaseBranch(
  q: (name: string) => string,
  scope: string,
  memberships: SupabaseMembershipTable & { readonly tenant: string },
  declared: readonly string[],
  levels: boolean,
): string {
  const role = tenantRole(memberships);
  const match = `c.tenant_id::text = requested_tenant and c.scope = ${literal(scope)} and c.scope_id is null and c.role = ${role.sql}`;
  const rows = (source: string, value: string, extra: string): string =>
    `array(select c.${value} from ${q(source)} c where ${match}${extra})`;
  return ` or exists (
      select 1
      from ${qualifiedTable(memberships.table)} m${role.join}
      where m.${ident(memberships.user)} = v_member_user
        and m.${ident(memberships.tenant)} = v_member_tenant
        and not (${role.sql} = any(${textArray(declared)}))${
          memberships.expiresAt === undefined
            ? ""
            : `\n        and (m.${ident(memberships.expiresAt)} is null or m.${ident(memberships.expiresAt)} > now())`
        }
        and ${customHolds(
          q,
          scope,
          rows(
            "custom_role_permissions",
            levels
              ? "permission || coalesce('@' || c.level, '')"
              : "permission",
            " and c.effect = 'allow'",
          ),
          rows(
            "custom_role_permissions",
            "permission",
            " and c.effect = 'deny'",
          ),
          rows("custom_role_includes", "include_role", ""),
        )}
    )`;
}

/**
 * The `role_permissions` match for one effect. An allow counts only without
 * row conditions (`grant_key = permission`): `authorize()` never sees the row.
 * A deny counts with or without them, so a conditional deny still denies.
 */
function effectMatch(scope: string, effect: "allow" | "deny"): string {
  return `rp.permission = requested_permission::text
        and rp.scope = ${scope}
        and rp.effect = '${effect}'${effect === "allow" ? "\n        and rp.grant_key = rp.permission" : ""}`;
}

function databaseBody(
  q: (name: string) => string,
  scope: string,
  memberships: SupabaseMembershipTable | undefined,
  custom: AuthorizeSqlOptions["customRoles"],
  suspension: SupabaseSuspension | undefined,
): string {
  const global = (effect: "allow" | "deny"): string => `exists (
      select 1
      from ${q("user_roles")} ur
      join ${q("role_permissions")} rp on rp.role = ur.role::text
      where ur.user_id = uid
        and ${effectMatch(`'global'`, effect)}
    )`;
  const tenantColumn = memberships?.tenant;
  let tenantBranch = `  if requested_tenant is not null then
    return false; -- no memberships table configured
  end if;`;
  if (memberships !== undefined && tenantColumn !== undefined) {
    const role = tenantRole(memberships);
    const held = (effect: "allow" | "deny"): string => `exists (
      select 1
      from ${qualifiedTable(memberships.table)} m${role.join}
      join ${q("role_permissions")} rp on rp.role = ${role.sql}
      where m.${ident(memberships.user)} = v_member_user
        and m.${ident(tenantColumn)} = v_member_tenant
        and ${effectMatch(literal(scope), effect)}${
          memberships.expiresAt === undefined
            ? ""
            : `\n        and (m.${ident(memberships.expiresAt)} is null or m.${ident(memberships.expiresAt)} > now())`
        }
    )`;
    tenantBranch = `  if requested_tenant is not null then
    begin
      v_member_user := uid;
      v_member_tenant := requested_tenant;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return false; -- not an id of the memberships table
    end;
    return (${held("allow")}${custom === undefined ? "" : customDatabaseBranch(q, scope, { ...memberships, tenant: tenantColumn }, custom.declared, custom.levels === true)})
    and not ${held("deny")}
    and not ${global("deny")};
  end if;`;
  }
  const typed =
    memberships !== undefined && tenantColumn !== undefined
      ? `
  v_member_user ${qualifiedTable(memberships.table)}.${ident(memberships.user)}%type;
  v_member_tenant ${qualifiedTable(memberships.table)}.${ident(tenantColumn)}%type;`
      : "";
  return `declare
  uid uuid := (select auth.uid());${typed}
begin
  if uid is null then
    return false;
  end if;${suspendedGuards(suspension, scope, "uid")}
${tenantBranch}
  return ${global("allow")}
    and not ${global("deny")};
end;`;
}

/** A claim membership whose `expiresAt` (epoch seconds) has passed no longer holds its roles. */
const CLAIM_UNEXPIRED = `case jsonb_typeof(m -> 'expiresAt')
          when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
          else true
        end`;

function jwtBody(
  q: (name: string) => string,
  scope: string,
  custom: AuthorizeSqlOptions["customRoles"],
  suspension: SupabaseSuspension | undefined,
): string {
  const memberships = `jsonb_array_elements(
        case jsonb_typeof(coalesce(claims -> 'memberships', claims -> 'app_metadata' -> 'memberships'))
          when 'array' then coalesce(claims -> 'memberships', claims -> 'app_metadata' -> 'memberships')
          else '[]'::jsonb
        end
      ) m
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(m -> 'roles') when 'array' then m -> 'roles' else '[]'::jsonb end
      ) r(role)`;
  const customBranch =
    custom === undefined
      ? ""
      : ` or exists (
      select 1
      from ${memberships}
      cross join lateral (select m -> 'grants' -> r.role as g) cg
      where m ->> 'scope' = ${literal(scope)}
        and m ->> 'id' = requested_tenant
        and ${CLAIM_UNEXPIRED}
        and jsonb_typeof(cg.g) = 'array'
        and not (r.role = any(${textArray(custom.declared)}))
        and ${customHolds(
          q,
          scope,
          claimEntries("left(e, 1) not in ('-', '@')", "e"),
          claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
          claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
        )}
    )`;
  const held = (effect: "allow" | "deny"): string => `exists (
      select 1
      from ${memberships}
      join ${q("role_permissions")} rp on rp.role = r.role
      where m ->> 'scope' = ${literal(scope)}
        and m ->> 'id' = requested_tenant
        and ${CLAIM_UNEXPIRED}
        and ${effectMatch(literal(scope), effect)}
    )`;
  const global = (effect: "allow" | "deny"): string => `exists (
      select 1
      from jsonb_array_elements_text(
        case jsonb_typeof(role_claim)
          when 'array' then role_claim
          when 'string' then jsonb_build_array(role_claim)
          else '[]'::jsonb
        end
      ) r(role)
      join ${q("role_permissions")} rp on rp.role = r.role
      where ${effectMatch(`'global'`, effect)}
    )`;
  return `declare
  claims jsonb := (select auth.jwt());
  role_claim jsonb;
begin
  if claims is null or (select auth.uid()) is null then
    return false;
  end if;${suspendedGuards(suspension, scope, "(select auth.uid())")}
  -- a top-level null (no role row) falls back to app_metadata, like subjectFromSupabase
  role_claim := coalesce(nullif(claims -> 'user_role', 'null'::jsonb), claims -> 'app_metadata' -> 'user_role');
  if requested_tenant is not null then
    return (${held("allow")}${customBranch})
    and not ${held("deny")}
    and not ${global("deny")};
  end if;
  return ${global("allow")}
    and not ${global("deny")};
end;`;
}

/**
 * `authorize(requested_permission, requested_tenant text default null)` for Supabase's RBAC
 * scaffold, over the `role_permissions (role, permission, grant_key, scope, effect)` table that
 * `permdock rls generate` seeds. `database` reads `user_roles` (and the memberships table for a
 * tenant) on every call; `jwt` reads the hook-injected `user_role` and `memberships` claims. A
 * tenant request with no memberships source is denied, never answered from global roles. It
 * answers "does a role hold this permission" without seeing a row: an allow with row conditions
 * does not count, and a deny the user's tenant or global roles hold overrides every allow.
 * Generated policies call the per-statement RLS helpers (`permdock_has`, `permitted_<scope>_ids`)
 * instead. Only `authenticated` may execute it.
 */
export function authorizeSql(options: AuthorizeSqlOptions = {}): string {
  const schema = options.schema ?? PERMDOCK_SCHEMA;
  const q = (name: string): string => table(`${schema}.${name}`);
  const memberships =
    typeof options.tenant === "object" ? options.tenant : undefined;
  const scope = options.scope ?? "tenant";
  if (!/^[a-z][a-z0-9_]*$/u.test(scope)) {
    throw new TypeError(`PermDock: unsafe scope name '${scope}'`);
  }
  const body =
    options.authorize === "jwt"
      ? jwtBody(q, scope, options.customRoles, options.suspension)
      : databaseBody(
          q,
          scope,
          memberships,
          options.customRoles,
          options.suspension,
        );
  const signature = `${q("authorize")}(${q("app_permission")}, text)`;
  return `create or replace function ${q("authorize")}(
  requested_permission ${q("app_permission")},
  requested_tenant text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
${body}
$$;
revoke execute on function ${signature} from public, anon;
grant execute on function ${signature} to authenticated;
`;
}
