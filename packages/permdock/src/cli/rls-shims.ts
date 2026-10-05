import type { RolePermission } from "./rls-helpers.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type {
  RlsMigrateConfig,
  RlsMigrateHelper,
  RlsShimsConfig,
} from "./types.ts";

import { breakGlassKey } from "./rls-grants.ts";
import { HELPERS, qualified } from "./rls-helpers.ts";
import {
  memberIdsHelper,
  permittedIdsHelper,
  quoteIdent,
  quoteLiteral,
  scopeTypeOf,
} from "./rls-sql.ts";

const NAME = /^[a-z_][a-z0-9_]*$/u;

/**
 * The key a legacy caller passes, mapped the way `rls migrate` maps it:
 * `keys` and `renamed` exactly, then the longest `prefixes` entry.
 */
function mappedKey(
  config: RlsMigrateConfig,
  renamed: Readonly<Record<string, string>>,
): string {
  const exact = { ...renamed, ...config.keys };
  const prefixes = Object.entries(config.prefixes ?? {}).toSorted(
    ([a], [b]) => b.length - a.length,
  );
  const fallback =
    prefixes.length === 0
      ? "p_key"
      : `case ${prefixes
          .map(
            ([from, to]) =>
              `when pg_catalog.starts_with(p_key, ${quoteLiteral(from)}) then ${quoteLiteral(to)} || pg_catalog.substr(p_key, ${String(from.length + 1)})`,
          )
          .join(" ")} else p_key end`;
  if (Object.keys(exact).length === 0) {
    return fallback;
  }
  return `coalesce(${quoteLiteral(JSON.stringify(exact))}::jsonb ->> p_key, ${fallback})`;
}

function scopeOf(ctx: RlsSqlContext, scope: string): string {
  if (!ctx.scopes.some((item) => item.name === scope)) {
    throw new Error(
      `PermDock CLI: rls.migrate helper scope '${scope}' is not a declared scope`,
    );
  }
  return scope;
}

/** Per scope and permission key, the grant keys a shim may answer from. */
export type ShimGrants = ReadonlyMap<
  string,
  Readonly<
    Record<
      string,
      { readonly allow: readonly string[]; readonly deny: readonly string[] }
    >
  >
>;

/**
 * The grant keys behind each permission, per scope: the keys of its
 * unconditional allows, and every deny key. A shim cannot apply a row
 * condition or a validity window, so a conditional allow answers nothing and
 * a conditional deny always subtracts. A break-glass key answers only the
 * break-glass read, so it is left out too. Rows seeded under a former key are
 * left out; the shim maps a former key to the current one first.
 */
export function shimGrants(
  rows: readonly RolePermission[],
  conditioned: ReadonlySet<string>,
  renamed: Readonly<Record<string, string>>,
): ShimGrants {
  const byScope = new Map<
    string,
    Record<string, { allow: string[]; deny: string[] }>
  >();
  for (const row of rows.toSorted((a, b) =>
    a.grantKey < b.grantKey ? -1 : a.grantKey > b.grantKey ? 1 : 0,
  )) {
    if (Object.hasOwn(renamed, row.permission)) {
      continue;
    }
    if (
      row.effect === "allow" &&
      (conditioned.has(row.grantKey) ||
        row.grantKey === breakGlassKey(row.permission))
    ) {
      continue;
    }
    const scope = byScope.get(row.scope) ?? {};
    byScope.set(row.scope, scope);
    const entry = Object.hasOwn(scope, row.permission)
      ? scope[row.permission]
      : undefined;
    const keys = entry ?? { allow: [], deny: [] };
    scope[row.permission] = keys;
    const list = row.effect === "allow" ? keys.allow : keys.deny;
    if (!list.includes(row.grantKey)) {
      list.push(row.grantKey);
    }
  }
  return byScope;
}

function shimFunction(
  name: string,
  args: string,
  argTypes: string,
  returns: string,
  sql: string,
): string {
  return `create or replace function ${name}(${args})
returns ${returns}
language sql
stable
security definer
set search_path = ''
as $$
${sql}
$$;
revoke execute on function ${name}(${argTypes}) from public, anon;
grant execute on function ${name}(${argTypes}) to authenticated;`;
}

type Keys = {
  /** The JSON map of one scope's grant keys, as a `jsonb` literal. */
  readonly map: (scope: string) => string;
  /** The current permission key the caller's key maps to. */
  readonly key: string;
};

function grantKeys(
  keys: Keys,
  scope: string,
  effect: "allow" | "deny",
): string {
  return `pg_catalog.jsonb_array_elements_text(coalesce(${keys.map(scope)} -> (${keys.key}) -> ${quoteLiteral(effect)}, '[]'::jsonb)) g(grant_key)`;
}

/** The instances of `scope` the caller holds an unconditional allow of the key in, minus those it holds a deny in. */
function idsSql(ctx: RlsSqlContext, keys: Keys, scope: string): string {
  const helper = qualified(ctx, permittedIdsHelper(scope));
  return `  select a.id
  from ${grantKeys(keys, scope, "allow")}
  cross join lateral ${helper}(g.grant_key) a(id)
  except
  select d.id
  from ${grantKeys(keys, scope, "deny")}
  cross join lateral ${helper}(g.grant_key) d(id)`;
}

function hasSql(ctx: RlsSqlContext, keys: Keys): string {
  const has = qualified(ctx, HELPERS.has);
  return `exists (select 1 from ${grantKeys(keys, "global", "allow")} where ${has}(g.grant_key))
    and not exists (select 1 from ${grantKeys(keys, "global", "deny")} where ${has}(g.grant_key))`;
}

function shim(
  ctx: RlsSqlContext,
  config: RlsMigrateConfig,
  keys: Keys,
  fn: string,
  helper: RlsMigrateHelper,
): string {
  switch (helper.form) {
    case "ids": {
      const scope = scopeOf(ctx, helper.scope);
      return shimFunction(
        fn,
        "p_key text",
        "text",
        `setof ${scopeTypeOf(ctx, scope)}`,
        idsSql(ctx, keys, scope),
      );
    }
    case "row": {
      const scope = scopeOf(ctx, helper.scope);
      const type = scopeTypeOf(ctx, scope);
      return shimFunction(
        fn,
        `p_id ${type}, p_key text`,
        `${type}, text`,
        "boolean",
        `  select coalesce(p_id in (\n${idsSql(ctx, keys, scope)}\n  ), false)`,
      );
    }
    case "membership": {
      const scope = scopeOf(ctx, helper.scope);
      const type = scopeTypeOf(ctx, scope);
      return shimFunction(
        fn,
        `p_id ${type}`,
        type,
        "boolean",
        `  select coalesce(p_id in (select ${qualified(ctx, memberIdsHelper(scope))}()), false)`,
      );
    }
    case "global":
      return shimFunction(
        fn,
        "p_key text",
        "text",
        "boolean",
        `  select ${hasSql(ctx, keys)}`,
      );
    case "scoped": {
      const literals = new Map<string, string>();
      for (const scope of ctx.scopes) {
        literals.set(scope.name, scope.name);
      }
      for (const [literal, scope] of Object.entries(config.scopes ?? {})) {
        literals.set(literal, scopeOf(ctx, scope));
      }
      const global = config.globalScopes ?? [];
      const branches = [
        ...(global.length === 0
          ? []
          : [
              `    when p_scope in (${global.map(quoteLiteral).join(", ")}) then ${hasSql(ctx, keys)}`,
            ]),
        ...[...literals]
          .filter(([literal]) => !global.includes(literal))
          .map(
            ([literal, scope]) =>
              `    when p_scope = ${quoteLiteral(literal)} then coalesce(p_id in (select s.id::text from (\n${idsSql(ctx, keys, scope)}\n    ) s(id)), false)`,
          ),
      ];
      return shimFunction(
        fn,
        "p_scope text, p_id text, p_key text",
        "text, text, text",
        "boolean",
        `  select case\n${branches.join("\n")}\n    else false\n  end`,
      );
    }
    default: {
      const exhaustive: never = helper;
      return exhaustive;
    }
  }
}

/**
 * One wrapper per `rls.migrate.helpers` entry under its legacy name, so SQL
 * that `rls migrate` has not rewritten yet (function bodies, views, triggers)
 * answers from the PermDock helpers. A wrapper maps the legacy key to the
 * permission key, then to the grant keys `grants` lists for the helper's
 * scope, so a permission whose grants are split by condition still answers.
 * Each is `security definer` with an empty `search_path`, so a caller needs
 * `execute` on the wrapper only, not usage on the helper schema.
 */
export function shimsSql(
  ctx: RlsSqlContext,
  config: RlsMigrateConfig,
  shims: RlsShimsConfig,
  renamed: Readonly<Record<string, string>>,
  grants: ShimGrants,
): string {
  const schema = shims.schema ?? "public";
  const keys: Keys = {
    key: mappedKey(config, renamed),
    map: (scope) =>
      `${quoteLiteral(JSON.stringify(grants.get(scope) ?? {}))}::jsonb`,
  };
  const chunks = [
    `-- permdock shims: legacy helper names over the permdock helpers; drop each once doctor reports no caller (PD056)`,
  ];
  for (const [name, helper] of Object.entries(config.helpers).toSorted(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    if (!NAME.test(name)) {
      throw new Error(`PermDock CLI: unsafe rls.migrate helper name '${name}'`);
    }
    chunks.push(
      shim(ctx, config, keys, `${quoteIdent(schema)}.${name}`, helper),
    );
  }
  return `${chunks.join("\n\n")}\n`;
}
