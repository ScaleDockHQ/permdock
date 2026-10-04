import type { RlsSqlContext } from "./rls-sql.ts";
import type {
  RlsMigrateConfig,
  RlsMigrateHelper,
  RlsShimsConfig,
} from "./types.ts";

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
security invoker
set search_path = ''
as $$
${sql}
$$;
revoke execute on function ${name}(${argTypes}) from public, anon;
grant execute on function ${name}(${argTypes}) to authenticated;`;
}

function shim(
  ctx: RlsSqlContext,
  config: RlsMigrateConfig,
  key: string,
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
        `  select * from ${qualified(ctx, permittedIdsHelper(scope))}(${key})`,
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
        `  select coalesce(p_id in (select ${qualified(ctx, permittedIdsHelper(scope))}(${key})), false)`,
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
        `  select ${qualified(ctx, HELPERS.has)}(${key})`,
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
              `    when p_scope in (${global.map(quoteLiteral).join(", ")}) then ${qualified(ctx, HELPERS.has)}(${key})`,
            ]),
        ...[...literals]
          .filter(([literal]) => !global.includes(literal))
          .map(
            ([literal, scope]) =>
              `    when p_scope = ${quoteLiteral(literal)} then coalesce(p_id in (select ids::text from ${qualified(ctx, permittedIdsHelper(scope))}(${key}) as ids), false)`,
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
 * answers from the PermDock helpers. Each is `security invoker`: it reads no
 * table, and the helpers it calls are the `security definer` ones.
 */
export function shimsSql(
  ctx: RlsSqlContext,
  config: RlsMigrateConfig,
  shims: RlsShimsConfig,
  renamed: Readonly<Record<string, string>>,
): string {
  const schema = shims.schema ?? "public";
  const key = mappedKey(config, renamed);
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
      shim(ctx, config, key, `${quoteIdent(schema)}.${name}`, helper),
    );
  }
  return `${chunks.join("\n\n")}\n`;
}
