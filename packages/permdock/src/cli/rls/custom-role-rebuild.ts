import type { RlsSqlContext } from "../sql/context.ts";
import type {
  RlsCustomRolesFrom,
  RlsCustomRoleTable,
  RlsMigrateConfig,
  RoleThrough,
} from "../types.ts";

import { qualifySqlTable, sqlTextArray } from "../../core/sql.ts";
import { type RoleSource, roleColumn } from "../../supabase/roles.ts";
import { configError } from "../core/errors.ts";
import { byCodeUnit, byKey } from "../shared/compare.ts";
import { beforeFirst } from "../shared/text.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  quoteTable,
} from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import { currentKeyExpr, rolesTableScope } from "./custom-roles.ts";

const PREFIX = "PermDock CLI";

/** A column of the roles-table row `r`. */
function col(name: string): string {
  return `r.${quoteIdent(name)}`;
}

function schemaOf(table: string): string {
  return table.includes(".") ? beforeFirst(table, ".") : "public";
}

/**
 * The roles-table column a reference joins on, after checking it points at
 * `roles`.
 */
function roleRef(
  role: RoleThrough,
  table: string,
  roles: RlsCustomRoleTable,
  label: string,
): { readonly ref: string; readonly id: string } {
  const pairs = Object.entries(role.on);
  const [pair] = pairs;
  if (pair === undefined || pairs.length !== 1) {
    throw configError(
      `${PREFIX}: ${label}.on must map exactly one column of ${table} to ${role.through}, for example { role_id: 'id' }`,
    );
  }
  const through = role.through.includes(".")
    ? role.through
    : `${schemaOf(table)}.${role.through}`;
  if (qualifySqlTable(through) !== qualifySqlTable(roles.table)) {
    throw configError(
      `${PREFIX}: ${label}.through must be rls.customRoleWrites.roles.table (${roles.table}), got ${role.through}`,
    );
  }
  if (role.column !== roles.key) {
    throw configError(
      `${PREFIX}: ${label}.column must be rls.customRoleWrites.roles.key (${roles.key}), got ${role.column}`,
    );
  }
  const [ref, id] = pair;
  return { ref, id };
}

/**
 * A legacy key as SQL the way `mapKey` maps it: `rls.migrate.keys`, then
 * `renamed`, then the longest `rls.migrate.prefixes` match, and a former key
 * read as its current key.
 */
export function legacyKeySql(
  expr: string,
  migrate: RlsMigrateConfig | undefined,
  renamed: Readonly<Record<string, string>>,
): string {
  const exact = new Map<string, string>(Object.entries(renamed));
  for (const [from, to] of Object.entries(migrate?.keys ?? {})) {
    exact.set(from, to);
  }
  const prefixes = Object.entries(migrate?.prefixes ?? {}).toSorted(
    ([a], [b]) => b.length - a.length || byCodeUnit(a, b),
  );
  const prefixed =
    prefixes.length === 0
      ? expr
      : `(case ${prefixes
          .map(
            ([from, to]) =>
              `when left(${expr}, ${String(from.length)}) = ${quoteLiteral(from)} then ${quoteLiteral(to)} || substr(${expr}, ${String(from.length + 1)})`,
          )
          .join(" ")} else ${expr} end)`;
  const mapped =
    exact.size === 0
      ? prefixed
      : `(case ${expr} ${[...exact.entries()]
          .toSorted(byKey)
          .map(
            ([from, to]) =>
              `when ${quoteLiteral(from)} then ${quoteLiteral(to)}`,
          )
          .join(" ")} else ${prefixed} end)`;
  const renames = Object.entries(renamed).toSorted(byKey);
  return currentKeyExpr(renames, mapped);
}

function sourceSql(source: RoleSource, table: string, label: string): string {
  return roleColumn(source, table, "x", { label, prefix: PREFIX }).lookup;
}

/**
 * The legacy-table reads of custom roles, as SQL over a row `r` of the roles
 * table; shared by the backfill and the sync trigger.
 */
export type RebuildPlan = {
  readonly rolesTable: string;
  /**
   * `select` list of a role row: `tenant_id`, `scope`, `scope_id`, `role`,
   * `permissions_ref`, `includes_ref`.
   */
  readonly identity: string;
  /**
   * Rows that are roles PermDock holds: not a skipped tenant row, not a
   * declared name.
   */
  readonly eligible: string;
  readonly permsRef: { readonly ref: string; readonly id: string };
  readonly includesRef:
    | { readonly ref: string; readonly id: string }
    | undefined;
  readonly scopes: string;
  /**
   * PL/pgSQL over a record `v` (`tenant_id`, `scope`, `scope_id`, `role`,
   * `permissions_ref`, `includes_ref`) and the variables `v_allow`, `v_deny`,
   * `v_include`, `v_lost`, `v_dropped`: sets the entries and appends what
   * PermDock cannot hold to `v_dropped`.
   */
  readonly collect: string;
  readonly replace: string;
  readonly perms: string;
  readonly includes: string;
  readonly declared: string;
  readonly roles: RlsCustomRoleTable;
};

export function rebuildPlan(
  ctx: RlsSqlContext,
  from: RlsCustomRolesFrom,
  migrate: RlsMigrateConfig | undefined,
): RebuildPlan {
  const custom = ctx.customRoles;
  const root = ctx.scopes[0]?.name;
  if (custom === undefined || root === undefined) {
    throw configError(`${PREFIX}: rls.customRoles.from needs custom roles on`);
  }
  if (ctx.authorize !== "database") {
    throw configError(
      `${PREFIX}: rls.customRoles.from needs database mode; in jwt mode custom roles ride the token, so build the grants claim with customRoleClaim`,
    );
  }
  const roles = custom.table;
  if (roles === undefined) {
    throw configError(
      `${PREFIX}: rls.customRoles.from needs rls.customRoleWrites.roles, the roles table each row belongs to`,
    );
  }
  const leveled = custom.levels === true;
  if (from.permissions.level !== undefined && !leveled) {
    throw configError(
      `${PREFIX}: rls.customRoles.from.permissions.level is set, but no resource declares levels`,
    );
  }
  const tenantType = tenantTypeOf(ctx);
  const rolesTable = quoteQualified(roles.table);
  const tenant =
    roles.tenant === undefined
      ? `null::${tenantType}`
      : `${col(roles.tenant)}::${tenantType}`;
  const scope = rolesTableScope(roles, tenant, root, col);
  const scopeId =
    roles.id === undefined || roles.tenant === undefined
      ? "null::text"
      : `case when ${tenant} is null then null else ${col(roles.id)}::text end`;
  // A row with no tenant (a global or shared role) is a role of everyone: `skip` marks tenant rows only.
  const skipped =
    roles.skip === undefined || roles.tenant === undefined
      ? "false"
      : `(${tenant} is not null and coalesce(${col(roles.skip)}, false))`;
  const renamed = custom.renamed ?? {};
  const renames = Object.entries(renamed).toSorted(byKey);
  const current = (expr: string): string => currentKeyExpr(renames, expr);
  const known = sqlTextArray([
    ...(custom.permissions ?? []),
    ...renames.map(([former]) => former),
  ]);
  const declared = sqlTextArray(custom.declared);
  const scopes = sqlTextArray(ctx.scopes.map((item) => item.name));
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const rp = qualified(ctx, "role_permissions");
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const replace = qualified(ctx, CUSTOM_ROLES.trustedReplace);

  const p = from.permissions;
  const pTable = qualifySqlTable(p.table);
  const pRef = roleRef(
    p.role,
    p.table,
    roles,
    "rls.customRoles.from.permissions.role",
  );
  const legacy = sourceSql(
    p.permission,
    pTable,
    "rls.customRoles.from.permissions.permission",
  );
  const effect =
    p.effect === undefined
      ? "'allow'"
      : `coalesce(lower(x.${quoteIdent(p.effect)}::text), 'allow')`;
  const level =
    p.level === undefined
      ? "null::text"
      : `nullif(x.${quoteIdent(p.level)}::text, '')`;
  const inCeiling = (key: string): string =>
    `exists (select 1 from ${ceiling} c where c.scope = v.scope and c.effect = 'allow' and ${current("c.permission")} = ${key})`;
  // A level only means something on a permission some ceiling key carries one for.
  const hasLevels = (key: string): string =>
    `exists (select 1 from ${ceiling} c where c.scope = v.scope and c.effect = 'allow' and ${current("c.permission")} = ${key} and position('@' in c.grant_key) > 0)`;
  const levelCheck = leveled
    ? `
          when m.effect = 'allow' and m.level is not null and ${hasLevels("m.key")} and not exists (
            select 1 from ${ceiling} c
            where c.scope = v.scope and c.effect = 'allow' and ${current("c.permission")} = m.key
              and split_part(c.grant_key, '@', 2) = m.level
          ) then 'level ' || m.level || ' is not declared'`
    : "";
  const allowEntry = leveled
    ? "j.key || coalesce('@' || j.level, '')"
    : "j.key";

  const i = from.includes;
  const iTable = i === undefined ? undefined : qualifySqlTable(i.table);
  const iRef =
    i === undefined || iTable === undefined
      ? undefined
      : roleRef(i.role, i.table, roles, "rls.customRoles.from.includes.role");
  const included =
    i === undefined || iTable === undefined
      ? undefined
      : sourceSql(i.include, iTable, "rls.customRoles.from.includes.include");

  const refs = [
    `${col(pRef.id)} as permissions_ref`,
    ...(iRef === undefined ? [] : [`${col(iRef.id)} as includes_ref`]),
  ].join(", ");
  const includeBlock =
    i === undefined ||
    iTable === undefined ||
    iRef === undefined ||
    included === undefined
      ? "    v_include := null;"
      : `    with raw as (
      select ${included} as role
      from ${quoteTable(iTable)} x
      where x.${quoteIdent(iRef.ref)} = v.includes_ref
    ),
    judged as (
      select n.role, case
          when n.role is null or not (n.role = any(${declared})) then 'not a declared role'
          when exists (
            select 1 from ${rp} rp
            where rp.role = n.role and rp.effect = 'allow'
              and not ${inCeiling(current("rp.permission"))}
          ) then 'allows permissions outside the ceiling of ' || v.scope
        end as dropped
      from raw n
    )
    select array_agg(distinct j.role) filter (where j.dropped is null),
      array_agg(v.role || ': includes ' || coalesce(j.role, 'null') || ', ' || j.dropped) filter (where j.dropped is not null)
    into v_include, v_lost
    from judged j;
    v_dropped := v_dropped || coalesce(v_lost, '{}'::text[]);`;

  const collect = `    with raw as (
      select ${legacy} as legacy, ${effect} as effect, ${level} as level
      from ${quoteTable(pTable)} x
      where x.${quoteIdent(pRef.ref)} = v.permissions_ref
    ),
    mapped as (
      select n.legacy, ${legacyKeySql("n.legacy", migrate, renamed)} as key, n.effect, n.level
      from raw n
    ),
    judged as (
      select m.legacy, m.key, m.effect, ${leveled ? `case when ${hasLevels("m.key")} then m.level end` : "m.level"} as level, case
          when m.effect not in ('allow', 'deny') then 'effect ' || m.effect || ' is not allow or deny'
          when m.key is null or not (m.key = any(${known})) then 'not a declared permission'
          when m.effect = 'allow' and not ${inCeiling("m.key")} then 'outside the ceiling of ' || v.scope${levelCheck}
        end as dropped
      from mapped m
    )
    select array_agg(distinct ${allowEntry}) filter (where j.dropped is null and j.effect = 'allow'),
      array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'deny'),
      array_agg(v.role || ': ' || coalesce(j.legacy, 'null') || ', ' || j.dropped) filter (where j.dropped is not null)
    into v_allow, v_deny, v_lost
    from judged j;
    v_dropped := v_dropped || coalesce(v_lost, '{}'::text[]);
${includeBlock}`;
  return {
    rolesTable,
    identity: `select ${tenant} as tenant_id, ${scope} as scope, ${scopeId} as scope_id, ${col(roles.key)}::text as role, ${refs}`,
    eligible: `not ${skipped} and not (${col(roles.key)}::text = any(${declared}))`,
    permsRef: pRef,
    includesRef: iRef,
    scopes,
    collect,
    replace,
    perms,
    includes,
    declared,
    roles,
  };
}

/**
 * `v_dropped` grouped per legacy role (`role: a, b; other: c`), capped at 50
 * entries.
 */
export const DROPPED_LIST = `(select string_agg(g.role || ': ' || g.items, '; ' order by g.role)
    from (
      select split_part(l.d, ': ', 1) as role, string_agg(substr(l.d, strpos(l.d, ': ') + 2), ', ' order by l.d) as items
      from (select u.d from unnest(v_dropped) as u(d) order by u.d limit 50) l
      group by 1
    ) g)`;
