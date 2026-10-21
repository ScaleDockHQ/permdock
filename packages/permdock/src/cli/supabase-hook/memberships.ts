import type { SupabaseManifestMembership } from "../../supabase/manifest.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type {
  RlsMembershipTable,
  RlsMemberships,
  SupabaseHookConfig,
} from "../types.ts";
import type { Parts } from "./parts.ts";

import { scopeColumn } from "../../conditions/compile.ts";
import { type Scope, resolveScope, scopeChain } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { roleManifest } from "../../supabase/roles.ts";
import { configError } from "../core/errors.ts";
import {
  hasMemberFor,
  hasPermittedUsers,
  memberForSources,
  memberForTable,
  memberRoleOf,
} from "../sql/names.ts";
import { quoteIdent, quoteLiteral, quoteQualified } from "../sql/quote.ts";

type MemberForInput = {
  readonly scopes: readonly Scope[];
  readonly memberships?: RlsMemberships;
  readonly memberSources: readonly SqlMembershipSource[];
};

export function memberForPlan(input: MemberForInput): {
  readonly memberFor: readonly string[];
  readonly holders: readonly string[];
  readonly memberships: readonly SupabaseManifestMembership[];
} {
  const memberFor = input.scopes
    .map((scope) => scope.name)
    .filter((name) => hasMemberFor({ dialect: "supabase", ...input }, name));
  const holders = memberFor.filter((name) => hasPermittedUsers(input, name));
  const entries = new Map<string, SupabaseManifestMembership>();
  for (const name of memberFor) {
    const mapped = memberForTable(input, name);
    const found =
      mapped === undefined
        ? memberForSources(input, name).map((source) => source.sql.manifest)
        : [mappedMembership(mapped, input.scopes, name)];
    for (const entry of found) {
      entries.set(JSON.stringify(entry), entry);
    }
  }
  return { memberFor, holders, memberships: [...entries.values()] };
}

/**
 * An `rls.memberships` table in the manifest's `tableMembershipSource` /
 * `junctionMembershipSource` shape, for scope `name`.
 */
function mappedMembership(
  mapped: RlsMembershipTable,
  scopes: readonly Scope[],
  name: string,
): SupabaseManifestMembership {
  const id = scopeColumn(mapped, scopes, name) ?? "";
  const within: Record<string, string> = {};
  for (const ancestor of scopeChain(scopes, name).slice(1)) {
    const column = scopeColumn(mapped, scopes, ancestor);
    if (column !== undefined) {
      within[ancestor] = column;
    }
  }
  const role = memberRoleOf(mapped);
  const columns = [
    mapped.user,
    id,
    ...role.columns,
    ...Object.values(within),
    ...(typeof mapped.via === "string" ? [mapped.via] : []),
    ...(mapped.expiresAt === undefined ? [] : [mapped.expiresAt]),
    ...(mapped.disabledAt === undefined ? [] : [mapped.disabledAt]),
  ];
  return {
    table: qualifySqlTable(mapped.table),
    user: { column: mapped.user },
    scope: { value: name },
    id: { column: id },
    role: roleManifest(role),
    ...(Object.keys(within).length === 0
      ? {}
      : { within: { columns: within } }),
    ...(mapped.via === undefined
      ? {}
      : {
          via:
            typeof mapped.via === "string"
              ? { column: mapped.via }
              : { value: mapped.via.value },
        }),
    ...(mapped.expiresAt === undefined
      ? {}
      : { expiresAt: { column: mapped.expiresAt } }),
    ...(mapped.disabledAt === undefined
      ? {}
      : { disabledAt: { column: mapped.disabledAt } }),
    columns: [...new Set(columns)],
  };
}

export function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw configError(`PermDock CLI: ${label} must be a positive integer`);
  }
  return number;
}

/**
 * SQL for the active first-scope id, as text, for user `uid`; a table source
 * compares its id column with `v_active_user`, declared as `userType`.
 */
export function activeFromSql(
  input: SupabaseHookConfig["activeFrom"],
  root: string,
): { readonly sql: string; readonly userType?: string } {
  const spec = input ?? `app_metadata.active_${root}`;
  if (typeof spec === "string" && spec.startsWith("app_metadata.")) {
    const key = spec.slice("app_metadata.".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw configError(`PermDock CLI: unsafe app_metadata key '${key}'`);
    }
    return { sql: `claims -> 'app_metadata' ->> ${quoteLiteral(key)}` };
  }
  const parsed =
    typeof spec === "string"
      ? (() => {
          const dot = spec.lastIndexOf(".");
          if (dot <= 0) {
            throw configError(
              `PermDock CLI: --active-from must be app_metadata.<key> or <table>.<column>, got '${spec}'`,
            );
          }
          return { table: spec.slice(0, dot), column: spec.slice(dot + 1) };
        })()
      : spec;
  const id = "id" in parsed && parsed.id !== undefined ? parsed.id : "id";
  return {
    sql: `(select a.${quoteIdent(parsed.column)}::text from ${quoteQualified(parsed.table)} a where a.${quoteIdent(id)} = v_active_user)`,
    userType: `${quoteQualified(parsed.table)}.${quoteIdent(id)}%type`,
  };
}

/**
 * One variable per user-keyed table the hook reads, holding `uid` (a uuid, as
 * Supabase Auth issues) as that column's type, so each lookup compares the
 * column uncast and its index applies.
 */
export function typedUsers(parts: Parts): string {
  const vars = [
    ...parts.sources.map(
      (source, index) =>
        `v_user_${String(index)} ${source.sql.userType} := uid;`,
    ),
    ...(parts.roles === undefined
      ? []
      : [
          `v_roles_user ${quoteQualified(parts.roles.table)}.${quoteIdent(parts.roles.user)}%type := uid;`,
        ]),
    ...(parts.attrs?.table === undefined || parts.attrs.columns.length === 0
      ? []
      : [
          `v_attrs_user ${quoteQualified(parts.attrs.table)}.${quoteIdent(parts.attrs.id)}%type := uid;`,
        ]),
    ...(parts.active.userType === undefined
      ? []
      : [`v_active_user ${parts.active.userType} := uid;`]),
  ];
  return vars.map((line) => `\n  ${line}`).join("");
}

export function checkSources(parts: {
  readonly sources: readonly SqlMembershipSource[];
  readonly scopes: readonly Scope[];
}): void {
  if (parts.sources.length === 0) {
    throw configError(
      "PermDock CLI: supabase.hook.memberships needs at least one tableMembershipSource or junctionMembershipSource source",
    );
  }
  for (const source of parts.sources) {
    if (source.sql === undefined || typeof source.sql.select !== "function") {
      throw configError(
        "PermDock CLI: supabase.hook.memberships takes tableMembershipSource / junctionMembershipSource sources from permdock/supabase",
      );
    }
    const scope = source.sql.scope;
    if (scope === undefined) {
      continue;
    }
    const name = resolveScope(parts.scopes, scope);
    if (name !== scope) {
      throw configError(
        `PermDock CLI: the ${source.sql.table} source names scope '${scope}', which the policy does not declare by that name`,
      );
    }
    const chain = scopeChain(parts.scopes, scope);
    const holds = new Set(source.sql.holds ?? [scope]);
    const missing = chain.filter((ancestor) => !holds.has(ancestor));
    if (missing.length > 0) {
      throw configError(
        `PermDock CLI: the ${source.sql.table} source needs within columns for ${missing.join(", ")}: a ${scope} membership without every ancestor grants nothing`,
      );
    }
  }
}

export function entriesSql(parts: Parts): string {
  const tenant = `case when s.scope = ${quoteLiteral(parts.root)} then s.id else s.within ->> ${quoteLiteral(parts.root)} end`;
  const selects = parts.sources.map(
    (source, index) => `select ${String(index)} as ord,
  (${tenant}) as tenant,
  jsonb_strip_nulls(jsonb_build_object(
    'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
    'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
    'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
    'managed_by', s.managed_by, 'entitlements', s.seats${source.sql.keeps ? ", 'keep', s.keep" : ""}
  )) as entry
from (
${source.sql.select(`v_user_${String(index)}`).replaceAll(/^/gmu, "  ")}
) s`,
  );
  return selects.join("\nunion all\n");
}
