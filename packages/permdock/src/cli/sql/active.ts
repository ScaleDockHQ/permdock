import type { Scope } from "../../core/scopes.ts";
import type {
  RlsActiveRow,
  RlsSuspendedScope,
  RlsSuspension,
} from "../types.ts";
import type { CheckedPermission, RlsSqlContext } from "./context.ts";

import { resolveScope, scopeChain } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { keptKeys } from "../../supabase/keep.ts";
import { configError } from "../core/errors.ts";
import { scopeTypeOf } from "./columns.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "./quote.ts";
import { subjectIdSql } from "./subject.ts";

function checkActiveRow(label: string, row: RlsActiveRow): void {
  quoteTable(row.table);
  quoteIdent(row.id);
  if (row.disabledAt !== undefined) {
    quoteIdent(row.disabledAt);
  }
  if (row.status !== undefined) {
    quoteIdent(row.status);
    if (row.active === undefined || row.active.length === 0) {
      throw configError(
        `PermDock CLI: ${label}.status needs the active values in ${label}.active`,
      );
    }
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw configError(
      `PermDock CLI: ${label} needs disabledAt or status to tell an active row`,
    );
  }
}

/** Validates `rls.suspension` and keys its scopes by declared name. */
export function checkSuspension(
  suspension: RlsSuspension | undefined,
  scopes: readonly Scope[],
): RlsSuspension | undefined {
  if (suspension === undefined) {
    return undefined;
  }
  if (suspension.users !== undefined) {
    checkActiveRow("rls.suspension.users", suspension.users);
  }
  const byName: Record<string, RlsSuspendedScope> = {};
  for (const [key, row] of Object.entries(suspension.scopes ?? {})) {
    const name = resolveScope(scopes, key);
    if (name === undefined) {
      throw configError(
        `PermDock CLI: rls.suspension.scopes.${key} names a scope the policy does not declare`,
      );
    }
    checkActiveRow(`rls.suspension.scopes.${key}`, row);
    if (row.keep !== undefined && !Array.isArray(row.keep)) {
      throw configError(
        `PermDock CLI: rls.suspension.scopes.${key}.keep is a list of permissions or permission keys`,
      );
    }
    const keep = keptKeys(row);
    const { keep: _given, ...active } = row;
    byName[name] = keep.length === 0 ? active : { ...active, keep };
  }
  const memberships = suspension.memberships;
  if (memberships?.keep !== undefined && !Array.isArray(memberships.keep)) {
    throw configError(
      "PermDock CLI: rls.suspension.memberships.keep is a list of permissions or permission keys",
    );
  }
  const keep = keptKeys(memberships);
  return {
    ...(suspension.users === undefined ? {} : { users: suspension.users }),
    ...(Object.keys(byName).length === 0 ? {} : { scopes: byName }),
    ...(keep.length === 0 ? {} : { memberships: { keep } }),
  };
}

export function disabledKeep(ctx: RlsSqlContext): readonly string[] {
  return keptKeys(ctx.suspension?.memberships);
}

export function activeMembershipSql(
  ctx: RlsSqlContext,
  disabledAt: string | undefined,
  permission: CheckedPermission | undefined = ctx.permission === undefined
    ? undefined
    : { key: ctx.permission },
): string[] {
  if (disabledAt === undefined) {
    return [];
  }
  const keep = disabledKeep(ctx);
  if (
    permission !== undefined &&
    "key" in permission &&
    keep.includes(permission.key)
  ) {
    return [];
  }
  return permission !== undefined && "sql" in permission && keep.length > 0
    ? [
        `(${disabledAt} is null or ${permission.sql} = any(array[${keep.map(quoteLiteral).join(", ")}]::text[]))`,
      ]
    : [`${disabledAt} is null`];
}

export function keptRowSql(
  keep: string,
  permission: CheckedPermission | undefined,
): string {
  const kind = `coalesce(jsonb_typeof(${keep}), 'null')`;
  if (permission === undefined) {
    return `${kind} = 'null'`;
  }
  const value =
    "key" in permission ? quoteLiteral(permission.key) : permission.sql;
  return `case ${kind} when 'null' then true when 'array' then ${keep} @> jsonb_build_array(${value}) else false end`;
}

/**
 * Whether `id` is among the active rows' ids: a missing row is suspended, so
 * the check fails closed, and so does a null `id`. `id` stays outside the
 * subquery so a column of the same name on `row.table` cannot capture it.
 */
export function activeRowSql(row: RlsActiveRow, id: string): string {
  const table = quoteTable(qualifySqlTable(row.table));
  const parts: string[] = [];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${quoteIdent(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = (row.active ?? []).map(quoteLiteral).join(", ");
    parts.push(
      `s.${quoteIdent(row.status)}::text = any(array[${values}]::text[])`,
    );
  }
  const where = parts.length === 0 ? "" : ` where ${parts.join(" and ")}`;
  return `coalesce(${id} in (select s.${quoteIdent(row.id)} from ${table} s${where}), false)`;
}

/** The active-user check for `user`; empty without `rls.suspension.users`. */
export function activeUserSql(
  ctx: RlsSqlContext,
  user: string = subjectIdSql(ctx),
): string[] {
  const row = ctx.suspension?.users;
  return row === undefined ? [] : [activeRowSql(row, user)];
}

/**
 * The permission of a grant key held in `grant`: `key#group` and `key@level`
 * name `key`.
 */
export function grantPermissionSql(grant: string): CheckedPermission {
  return { sql: `split_part(split_part(${grant}, '#', 1), '@', 1)` };
}

/**
 * The active-instance check for every suspendable scope on `scope`'s chain: its
 * own and each ancestor's. `idOf` gives the SQL for the id the membership holds
 * for a scope on that chain. A scope's `keep` lets `permission` through a
 * suspended instance: a kept key known now drops its check, and one read at run
 * time is compared with the kept keys.
 */
export function activeInstancesSql(
  ctx: RlsSqlContext,
  scope: string,
  idOf: (name: string) => string | undefined,
  permission: CheckedPermission | undefined = ctx.permission === undefined
    ? undefined
    : { key: ctx.permission },
): string[] {
  const parts: string[] = [];
  for (const name of scopeChain(ctx.scopes, scope)) {
    const row = ctx.suspension?.scopes?.[name];
    if (row === undefined) {
      continue;
    }
    const id = idOf(name);
    if (id === undefined) {
      throw configError(
        `PermDock CLI: rls.suspension.scopes.${name} needs the ${name} id on ${scope} memberships: add columns.${name} to the ${scope} memberships table`,
      );
    }
    const keep = keptKeys(row);
    if (
      permission !== undefined &&
      "key" in permission &&
      keep.includes(permission.key)
    ) {
      continue;
    }
    const active = activeRowSql(row, `(${id})::${scopeTypeOf(ctx, name)}`);
    parts.push(
      permission !== undefined && "sql" in permission && keep.length > 0
        ? `(${active} or ${permission.sql} = any(array[${keep.map(quoteLiteral).join(", ")}]::text[]))`
        : active,
    );
  }
  return parts;
}
