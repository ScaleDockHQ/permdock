import type { SupabaseHookClaim } from "../../supabase/manifest.ts";
import type { SupabaseHookConfig } from "../types.ts";
import type { Parts } from "./parts.ts";

import { PERMDOCK_CLAIMS_SCHEMA } from "../claims-schema.ts";
import { configError } from "../core/errors.ts";
import { quoteLiteral, quoteQualified, quoteTable } from "../sql/quote.ts";

const CLAIM_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const USER_EDITABLE = /^(raw_)?user_meta(_)?data$/iu;

export type AttrsPlan = {
  readonly table?: string;
  readonly id: string;
  /** Columns of `table`, each also the claim key. */
  readonly columns: readonly string[];
  /** `app_metadata` keys, each also the claim key. */
  readonly meta: readonly string[];
  readonly errors: readonly string[];
};

/**
 * Splits `supabase.hook.attrs` into table columns and `app_metadata` keys and
 * lists what cannot be compiled: `user_metadata` (the user can edit it), a
 * direct `auth.users` column, an unsafe or prototype key, a duplicate key,
 * or a table column without a table.
 */
export function attrsPlan(
  attrs: NonNullable<SupabaseHookConfig["attrs"]>,
): AttrsPlan {
  const errors: string[] = [];
  const columns: string[] = [];
  const meta: string[] = [];
  const seen = new Set<string>();
  const tableName = attrs.table?.replaceAll('"', "").toLowerCase();
  if (tableName === "auth.users") {
    errors.push(
      "supabase.hook.attrs.table cannot be auth.users: list app_metadata.<key> entries instead",
    );
  }
  for (const entry of attrs.columns) {
    const [head = "", ...rest] = entry.split(".");
    const isMeta = head === "app_metadata" || head === "raw_app_meta_data";
    const key = isMeta ? rest.join(".") : entry;
    if (
      USER_EDITABLE.test(head) ||
      USER_EDITABLE.test(key) ||
      /user_?meta/iu.test(entry)
    ) {
      errors.push(
        `supabase.hook.attrs lists ${entry}: user_metadata is user-editable and never becomes a claim`,
      );
      continue;
    }
    if (!CLAIM_KEY.test(key) || PROTOTYPE_KEYS.has(key)) {
      errors.push(
        `supabase.hook.attrs lists ${entry}: a key must match ${CLAIM_KEY.source} and not be a prototype key`,
      );
      continue;
    }
    if (seen.has(key)) {
      errors.push(`supabase.hook.attrs names the key ${key} twice`);
      continue;
    }
    seen.add(key);
    if (isMeta) {
      meta.push(key);
    } else {
      columns.push(key);
    }
  }
  if (columns.length > 0 && attrs.table === undefined) {
    errors.push(
      `supabase.hook.attrs lists ${columns.join(", ")} without a table`,
    );
  }
  return {
    ...(attrs.table === undefined ? {} : { table: attrs.table }),
    id: attrs.id ?? "id",
    columns,
    meta,
    errors,
  };
}

/**
 * Claim names `supabase.hook.claims` cannot write: the ones this hook owns
 * (plus the tenant claim) and the ones Supabase Auth issues.
 */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  "roles",
  "user_role",
  "memberships",
  "memberships_truncated",
  "attrs",
  "authz_ver",
  "sub",
  "aud",
  "role",
  "exp",
  "iat",
  "iss",
  "aal",
  "amr",
  "session_id",
  "is_anonymous",
  "email",
  "phone",
  "app_metadata",
  "user_metadata",
]);

const CLAIM_FUNCTION = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u;

export type ExtraClaim = {
  readonly claim: string;
  /** `<schema>.<function>(uuid) returns jsonb`. */
  readonly fn: string;
};

/**
 * Checks `supabase.hook.claims`: each name is a safe claim key outside
 * {@link RESERVED_CLAIMS} and the tenant claim, each function is
 * schema-qualified (the hook runs with an empty `search_path`).
 */
export function extraClaimsPlan(
  claims: SupabaseHookConfig["claims"],
  tenantClaim: string,
): {
  readonly claims: readonly ExtraClaim[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const planned: ExtraClaim[] = [];
  for (const [claim, fn] of Object.entries(claims ?? {})) {
    if (!CLAIM_KEY.test(claim) || PROTOTYPE_KEYS.has(claim)) {
      errors.push(
        `supabase.hook.claims names ${claim}: a claim must match ${CLAIM_KEY.source} and not be a prototype key`,
      );
      continue;
    }
    if (RESERVED_CLAIMS.has(claim) || claim === tenantClaim) {
      errors.push(
        `supabase.hook.claims names ${claim}, which PermDock or Supabase Auth writes`,
      );
      continue;
    }
    if (typeof fn !== "string" || !CLAIM_FUNCTION.test(fn)) {
      errors.push(
        `supabase.hook.claims.${claim} must be a schema-qualified function name such as public.feature_claims`,
      );
      continue;
    }
    planned.push({ claim, fn });
  }
  return { claims: planned, errors };
}

export function beforePlan(
  before: SupabaseHookConfig["before"],
): readonly string[] {
  const list =
    before === undefined ? [] : typeof before === "string" ? [before] : before;
  const bad = list.filter(
    (fn) => typeof fn !== "string" || !CLAIM_FUNCTION.test(fn),
  );
  if (bad.length > 0) {
    throw configError(
      `PermDock CLI: supabase.hook.before must name schema-qualified functions such as auth_checks.before_token (got ${bad.map(String).join(", ")})`,
    );
  }
  return [...new Set(list)];
}

export function beforeSql(before: readonly string[]): string {
  return before
    .map(
      (fn) => `
  checked := ${quoteTable(fn)}(event);
  if checked is null or jsonb_typeof(checked) is distinct from 'object' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 500, 'message', ${quoteLiteral(`${fn} returned no event`)}));
  end if;
  if checked ? 'error' then
    return checked;
  end if;
  event := checked;`,
    )
    .join("")
    .concat(before.length === 0 ? "" : "\n  claims := event -> 'claims';");
}

/**
 * `hook.validate`: the claims the hook writes, dropped together when they do
 * not match `supabase-claims-v1.json`, so a bad claim denies instead of
 * failing sign-in. `hook.claims` entries belong to other packages and stay.
 */
export function validateSql(parts: Parts): string {
  if (parts.hook.validate !== true) {
    return "";
  }
  const keys = new Set([
    "user_role",
    "roles",
    "memberships",
    "memberships_truncated",
    "attrs",
    "authz_ver",
    parts.tenantClaim,
  ]);
  return `
  if not extensions.jsonb_matches_schema(${quoteLiteral(JSON.stringify(PERMDOCK_CLAIMS_SCHEMA))}::json, claims) then
    claims := claims${[...keys].map((key) => ` - ${quoteLiteral(key)}`).join("")};
  end if;`;
}

export function validateGrantsSql(parts: Parts): string {
  return parts.hook.validate === true
    ? `
create extension if not exists pg_jsonschema with schema extensions;
grant usage on schema extensions to supabase_auth_admin;
grant execute on function extensions.jsonb_matches_schema(json, jsonb) to supabase_auth_admin;`
    : "";
}

/**
 * Fails the migration when a client role can write an `attrs` column: a
 * claim the user can set is not a server-owned attribute.
 */
export function attrsGuardSql(plan: AttrsPlan | undefined): string {
  if (plan?.table === undefined || plan.columns.length === 0) {
    return "";
  }
  const target = quoteLiteral(quoteQualified(plan.table));
  const columns = plan.columns
    .map((column) => `(${quoteLiteral(column)})`)
    .join(", ");
  return `-- attrs must be server-owned: refuse columns anon or authenticated can insert or update
do $$
begin
  if exists (
    select 1
    from (values ${columns}) c(name)
    cross join (values ('anon'), ('authenticated')) r(role)
    where has_column_privilege(r.role, ${target}, c.name, 'INSERT')
       or has_column_privilege(r.role, ${target}, c.name, 'UPDATE')
  ) then
    raise exception 'PermDock: an attrs column of % is writable by anon or authenticated; revoke insert and update on it before it becomes a claim', ${target}
      using errcode = '42501';
  end if;
end
$$;`;
}

function permdockClaim(name: string, budget = false): SupabaseHookClaim {
  return { name, source: "permdock", budget };
}

export function hookClaims(parts: Parts): readonly SupabaseHookClaim[] {
  return [
    permdockClaim("user_role"),
    permdockClaim("roles"),
    permdockClaim("memberships", true),
    permdockClaim("memberships_truncated"),
    permdockClaim(parts.tenantClaim),
    ...(parts.attrs === undefined ? [] : [permdockClaim("attrs", true)]),
    ...(parts.version ? [permdockClaim("authz_ver")] : []),
    ...parts.extra.map((entry) => ({
      name: entry.claim,
      source: entry.fn,
      budget: false,
    })),
  ];
}
