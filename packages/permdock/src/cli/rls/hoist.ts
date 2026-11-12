import type { RlsSqlContext } from "../sql/context.ts";

import { qualified, quoteLiteral } from "../sql/quote.ts";
import { USER_ID_HELPER } from "../sql/subject.ts";
import {
  API_KEY_ALLOWS,
  apiKeyClaimSql,
  apiKeyUnlimitedSql,
} from "./api-keys.ts";
import { PERMISSION_HELPERS } from "./permission-keys.ts";
import { TOKEN_SCOPE_ALLOWS, tokenScopeUnlimitedSql } from "./token-scopes.ts";

export const HOISTED = "permdock_hoisted";

export type PermissionArm = { readonly key: string; readonly sql: string };

export type HoistedArms = {
  readonly arms: readonly PermissionArm[];
  readonly columns: string | undefined;
};

const LITERAL_ARGS = "(?:'(?:[^']|'')*'(?:, ?'(?:[^']|'')*')*)?";

const UNLIMITED_KEY = "key_unlimited";

const UNLIMITED_SCOPE = "scope_unlimited";

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function callPattern(prefix: string, names: string): string {
  return `(?<!in )\\(select ${prefix}(?:${names})\\(${LITERAL_ARGS}\\)\\)`;
}

function invariantPattern(ctx: Pick<RlsSqlContext, "schema">): RegExp {
  const prefix = escape(qualified(ctx, ""));
  const scalar = [PERMISSION_HELPERS.has, USER_ID_HELPER].join("|");
  return new RegExp(
    `${callPattern(prefix, scalar)}|array\\(select ${prefix}\\w+_by_permission\\(${LITERAL_ARGS}\\)\\)`,
    "gu",
  );
}

function ceilingPattern(
  ctx: Pick<RlsSqlContext, "schema">,
  name: string,
): RegExp {
  return new RegExp(callPattern(escape(qualified(ctx, "")), name), "gu");
}

function guardCeilings(
  ctx: RlsSqlContext,
  sql: string,
  used: Set<string>,
): string {
  let out = sql;
  if (ctx.apiKeys !== undefined) {
    out = out.replaceAll(ceilingPattern(ctx, API_KEY_ALLOWS), (call) => {
      used.add(UNLIMITED_KEY);
      return `(${HOISTED}.${UNLIMITED_KEY} or ${call})`;
    });
  }
  if (ctx.tokenScopes !== undefined) {
    out = out.replaceAll(ceilingPattern(ctx, TOKEN_SCOPE_ALLOWS), (call) => {
      used.add(UNLIMITED_SCOPE);
      return `(${HOISTED}.${UNLIMITED_SCOPE} or ${call})`;
    });
  }
  return out;
}

function ceilingColumns(ctx: RlsSqlContext, used: Set<string>): string[] {
  const out: string[] = [];
  if (used.has(UNLIMITED_KEY) && ctx.apiKeys !== undefined) {
    out.push(
      `coalesce(${apiKeyUnlimitedSql(`(${apiKeyClaimSql(ctx, ctx.apiKeys)})`)}, false) as ${UNLIMITED_KEY}`,
    );
  }
  if (used.has(UNLIMITED_SCOPE)) {
    out.push(
      `coalesce(${tokenScopeUnlimitedSql(ctx)}, false) as ${UNLIMITED_SCOPE}`,
    );
  }
  return out;
}

export function hoistInvariants(
  ctx: RlsSqlContext,
  arms: readonly PermissionArm[],
): HoistedArms {
  const pattern = invariantPattern(ctx);
  const counts = new Map<string, number>();
  for (const arm of arms) {
    for (const call of arm.sql.match(pattern) ?? []) {
      counts.set(call, (counts.get(call) ?? 0) + 1);
    }
  }
  const found = new Map<string, { readonly column: string; keys: string[] }>();
  const ceilings = new Set<string>();
  const rewritten = arms.map((arm) => ({
    key: arm.key,
    sql: guardCeilings(
      ctx,
      arm.sql.replaceAll(pattern, (call) => {
        if ((counts.get(call) ?? 0) < 2) {
          return call;
        }
        let entry = found.get(call);
        if (entry === undefined) {
          entry = { column: `h${String(found.size + 1)}`, keys: [] };
          found.set(call, entry);
        }
        if (!entry.keys.includes(arm.key)) {
          entry.keys.push(arm.key);
        }
        return `${HOISTED}.${entry.column}`;
      }),
      ceilings,
    ),
  }));
  const columns = [
    ...[...found].map(
      ([call, { column, keys }]) =>
        `case when p_permission in (${keys.map(quoteLiteral).join(", ")}) then ${call} end as ${column}`,
    ),
    ...ceilingColumns(ctx, ceilings),
  ];
  return columns.length === 0
    ? { arms, columns: undefined }
    : { arms: rewritten, columns: columns.join(",\n    ") };
}
