import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Scope } from "../core/scopes.ts";
import type {
  SupabaseHookClaim,
  SupabaseHookManifest,
  SupabaseManifestHelper,
  SupabaseManifestMembership,
} from "../supabase/manifest.ts";
import type { RoleKeys } from "../supabase/roles.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type {
  CliIo,
  PermDockConfig,
  RlsActiveRow,
  RlsMembershipTable,
  RlsMemberships,
  SupabaseHookConfig,
} from "./types.ts";

import { scopeColumn } from "../conditions/compile.ts";
import {
  resolveScope,
  rootScope,
  scopeChain,
  scopeList,
} from "../core/scopes.ts";
import { roleManifest } from "../supabase/roles.ts";
import {
  AUTHZ_VERSION_TABLE,
  PERMDOCK_SCHEMA,
  supabaseMembershipsBudget,
  supabaseTenantClaim,
} from "../supabase/sources.ts";
import { decidingColumns, tableKey } from "./deciding-columns.ts";
import { globalRoleSource, type RoleRows } from "./global-roles.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { GRANTS_MARKER, HOOK_MARKER, hookMarkerFields } from "./markers.ts";
import { authAdminRead, hookUri, resolveAuthorize } from "./rls-rbac.ts";
import {
  activeRowSql,
  checkSuspension,
  hasMemberFor,
  memberForHelper,
  memberForSources,
  memberForTable,
  memberIdsHelper,
  memberRoleOf,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  scopeTypeOf,
} from "./rls-sql.ts";
import {
  driftOf,
  pgDeltaPath,
  type SqlFile,
  STDOUT,
  writeSqlFiles,
} from "./sql-files.ts";
import { supabaseConfig } from "./supabase-config.ts";
import {
  missingHelpersInDb,
  missingHelpersInFiles,
  missingHelpersMessage,
} from "./supabase-setup.ts";
import { SUPABASE_MANIFEST_SCHEMA } from "./version.ts";

const SUPABASE_HELP = `permdock supabase hook generate | inspect

  hook generate [--out supabase/permdock-hook.sql] [--check] [--db <url>]
                [--active-from app_metadata.active_<scope>|<table>.<column>]
                [--budget 1024] [--schema public] [--grants-out <file>|-]
  inspect [--json] [--out [permdock.manifest.json]] [--check]

Reads supabase.hook from permdock.config.ts: the fromTable / fromJunction sources the app
passes as memberships. hook generate emits custom_access_token_hook(jsonb), the grants it
needs (in --grants-out instead, for declarative schemas), the permdock_authz_version table
and its triggers. Never grants anything to
service_role. inspect prints the manifest: helper schema, names and signatures, tenant claim,
budget, the claims the hook writes, the membership sources and the columns that decide them.
--out writes it as JSON, to permdock.manifest.json without a path; --check exits 1 when that
file differs.
`;

const MANIFEST_FILE = "permdock.manifest.json";

const MANAGED_TRIGGER = "permdock_protect_managed";

const CLAIM_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
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
function extraClaimsPlan(
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
        `supabase.hook.claims.${claim} must be a schema-qualified function name such as better_supabase.feature_claims`,
      );
      continue;
    }
    planned.push({ claim, fn });
  }
  return { claims: planned, errors };
}

const VERSION_TRIGGER = "permdock_authz_version";

const AUTHZ_VERSION_BUMP = "permdock_bump_authz_version_for";

type Parts = {
  readonly schema: string;
  readonly scopes: readonly Scope[];
  readonly root: string;
  readonly sources: readonly SqlMembershipSource[];
  readonly budget: number;
  readonly version: boolean;
  readonly jwtExpiry: number;
  readonly tenantClaim: string;
  readonly users: RlsActiveRow | undefined;
  readonly hook: SupabaseHookConfig;
  /** Global roles for `user_role` and `roles`; `undefined` with `roles: false`. */
  readonly roles: RoleRows | undefined;
  readonly active: ReturnType<typeof activeFromSql>;
  readonly attrs: AttrsPlan | undefined;
  readonly extra: readonly ExtraClaim[];
  /** The `rls.schema` helpers, and the scopes `rls generate` emits `member_<scope>_ids_for` for. */
  readonly helpers: {
    readonly schema: string;
    readonly memberFor: readonly string[];
    /** The sources `member_<scope>_ids_for` reads, deduplicated across scopes. */
    readonly memberships: readonly SupabaseManifestMembership[];
  };
};

type MemberForInput = {
  readonly scopes: readonly Scope[];
  readonly memberships?: RlsMemberships;
  readonly memberSources: readonly SqlMembershipSource[];
};

function memberForPlan(input: MemberForInput): {
  readonly memberFor: readonly string[];
  readonly memberships: readonly SupabaseManifestMembership[];
} {
  const memberFor = input.scopes
    .map((scope) => scope.name)
    .filter((name) => hasMemberFor({ dialect: "supabase", ...input }, name));
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
  return { memberFor, memberships: [...entries.values()] };
}

/** An `rls.memberships` table in the manifest's `fromTable` / `fromJunction` shape, for scope `name`. */
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
  ];
  return {
    table: mapped.table.includes(".") ? mapped.table : `public.${mapped.table}`,
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
    columns: [...new Set(columns)],
  };
}

function table(name: string): string {
  return quoteTable(name.includes(".") ? name : `public.${name}`);
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new Error(`PermDock CLI: ${label} must be a positive integer`);
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
      throw new Error(`PermDock CLI: unsafe app_metadata key '${key}'`);
    }
    return {
      sql: `claims -> 'app_metadata' ->> ${quoteLiteral(key)}`,
    };
  }
  const parsed =
    typeof spec === "string"
      ? (() => {
          const dot = spec.lastIndexOf(".");
          if (dot <= 0) {
            throw new Error(
              `PermDock CLI: --active-from must be app_metadata.<key> or <table>.<column>, got '${spec}'`,
            );
          }
          return { table: spec.slice(0, dot), column: spec.slice(dot + 1) };
        })()
      : spec;
  const id = "id" in parsed && parsed.id !== undefined ? parsed.id : "id";
  return {
    sql: `(select a.${quoteIdent(parsed.column)}::text from ${table(parsed.table)} a where a.${quoteIdent(id)} = v_active_user)`,
    userType: `${table(parsed.table)}.${quoteIdent(id)}%type`,
  };
}

/**
 * One variable per user-keyed table the hook reads, holding `uid` (a uuid, as
 * Supabase Auth issues) as that column's type, so each lookup compares the
 * column uncast and its index applies.
 */
function typedUsers(parts: Parts): string {
  const vars = [
    ...parts.sources.map(
      (source, index) =>
        `v_user_${String(index)} ${source.sql.userType} := uid;`,
    ),
    ...(parts.roles === undefined
      ? []
      : [
          `v_roles_user ${table(parts.roles.table)}.${quoteIdent(parts.roles.user)}%type := uid;`,
        ]),
    ...(parts.attrs?.table === undefined || parts.attrs.columns.length === 0
      ? []
      : [
          `v_attrs_user ${table(parts.attrs.table)}.${quoteIdent(parts.attrs.id)}%type := uid;`,
        ]),
    ...(parts.active.userType === undefined
      ? []
      : [`v_active_user ${parts.active.userType} := uid;`]),
  ];
  return vars.map((line) => `\n  ${line}`).join("");
}

function checkSources(parts: {
  readonly sources: readonly SqlMembershipSource[];
  readonly scopes: readonly Scope[];
}): void {
  if (parts.sources.length === 0) {
    throw new Error(
      "PermDock CLI: supabase.hook.memberships needs at least one fromTable or fromJunction source",
    );
  }
  for (const source of parts.sources) {
    if (source.sql === undefined || typeof source.sql.select !== "function") {
      throw new Error(
        "PermDock CLI: supabase.hook.memberships takes fromTable / fromJunction sources from permdock/supabase",
      );
    }
    const scope = source.sql.scope;
    if (scope === undefined) {
      continue;
    }
    const name = resolveScope(parts.scopes, scope);
    if (name !== scope) {
      throw new Error(
        `PermDock CLI: the ${source.sql.table} source names scope '${scope}', which the policy does not declare by that name`,
      );
    }
    const chain = scopeChain(parts.scopes, scope);
    const holds = new Set(source.sql.holds ?? [scope]);
    const missing = chain.filter((ancestor) => !holds.has(ancestor));
    if (missing.length > 0) {
      throw new Error(
        `PermDock CLI: the ${source.sql.table} source needs within columns for ${missing.join(", ")}: a ${scope} membership without every ancestor grants nothing`,
      );
    }
  }
}

function entriesSql(parts: Parts): string {
  const tenant = `case when s.scope = ${quoteLiteral(parts.root)} then s.id else s.within ->> ${quoteLiteral(parts.root)} end`;
  const selects = parts.sources.map(
    (source, index) => `select ${String(index)} as ord,
  (${tenant}) as tenant,
  jsonb_strip_nulls(jsonb_build_object(
    'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
    'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
    'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
    'managedBy', s.managed_by, 'entitlements', s.seats
  )) as entry
from (
${source.sql.select(`v_user_${String(index)}`).replaceAll(/^/gmu, "  ")}
) s`,
  );
  return selects.join("\nunion all\n");
}

function hookSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  const rows = parts.roles;
  const roles =
    rows === undefined
      ? `  held := '[]'::jsonb;`
      : `  select coalesce(jsonb_agg(distinct ${rows.roleSql} order by ${rows.roleSql}), '[]'::jsonb)
    into held
    from ${rows.from}
    where ${rows.userSql} = v_roles_user;`;
  const plan = parts.attrs;
  const fromTable =
    plan === undefined || plan.columns.length === 0 || plan.table === undefined
      ? ""
      : `
  select jsonb_strip_nulls(jsonb_build_object(${plan.columns
    .map(
      (column) => `${quoteLiteral(column)}, to_jsonb(p.${quoteIdent(column)})`,
    )
    .join(", ")}))
    into attrs
    from ${table(plan.table)} p
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
      : `${fromTable}${fromMeta}
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
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "uid")} then
    claims := claims - 'memberships_truncated' - 'attrs' - ${quoteLiteral(parts.tenantClaim)}${dropExtra};
    claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);${version}
    return jsonb_set(event, '{claims}', claims);
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
  item record;${typedUsers(parts)}${plan === undefined ? "" : "\n  attrs jsonb;"}${parts.extra.length === 0 ? "" : "\n  extra jsonb;"}${parts.version ? "\n  ver bigint;" : ""}
begin${suspended}
  claims := claims - 'attrs'${dropExtra};
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
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, ${quoteLiteral(`{${parts.tenantClaim}}`)}, to_jsonb(active));
  end if;${extra}${version}
  return jsonb_set(event, '{claims}', claims);
end;
$$;`;
}

/**
 * Everything the hook grants `supabase_auth_admin`, and the execute revoke:
 * the statements `supabase db diff` drops, so `--grants-out` moves them to
 * their own file.
 */
function grantsSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  return [
    `-- supabase_auth_admin: the grants and read policies the hook needs
grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;${extraGrantsSql(parts.extra)}${memberForGrantsSql(parts)}`,
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
        `\ngrant execute on function ${quoteTable(entry.fn)}(uuid) to supabase_auth_admin;`,
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

function versionSql(parts: Parts): string {
  if (!parts.version) {
    return "";
  }
  const schema = quoteIdent(parts.schema);
  const versionTable = `${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)}`;
  const bump = `${schema}.permdock_bump_authz_version`;
  const bumpFor = `${schema}.${AUTHZ_VERSION_BUMP}`;
  const tables = [
    ...new Map(
      parts.sources
        .filter((source) => source.sql.userThrough === undefined)
        .map((source) => [source.sql.table, source.sql.user]),
    ),
  ];
  if (parts.roles !== undefined) {
    tables.push([parts.roles.table, parts.roles.user]);
  }
  const triggers = tables
    .map(
      ([
        name,
        user,
      ]) => `drop trigger if exists ${quoteIdent(VERSION_TRIGGER)} on ${table(name)};
create trigger ${quoteIdent(VERSION_TRIGGER)}
  after insert or update or delete on ${table(name)}
  for each row execute function ${bump}(${quoteLiteral(user)});`,
    )
    .join("\n");
  return `-- the authorization version: bumped on every membership change, written to authz_ver
create table if not exists ${versionTable} (
  user_id uuid primary key references auth.users on delete cascade,
  version bigint not null default 0
);
alter table ${versionTable} enable row level security;
revoke all on table ${versionTable} from anon, authenticated, public;

-- bumps each listed user once, skipping users already deleted from auth.users; no client role may call it
create or replace function ${bumpFor}(p_users uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  insert into ${versionTable} as v (user_id, version)
  select distinct u, 1 from unnest(p_users) u
  where u is not null and exists (select 1 from auth.users au where au.id = u)
  on conflict (user_id) do update set version = v.version + 1
$$;
revoke execute on function ${bumpFor}(uuid[]) from public, anon, authenticated;

create or replace function ${bump}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
begin
  perform ${bumpFor}(array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ]::uuid[]);
  return null;
end;
$$;
revoke execute on function ${bump}() from public, anon, authenticated;
${triggers}${memberUsersVersionSql(parts, bumpFor)}${roleKeysVersionSql(parts, versionTable)}`;
}

function signedUp(user: string): string {
  return `exists (select 1 from auth.users a where a.id = ${user})`;
}

/**
 * Every membership source whose user id lives in another table: a row of
 * the source bumps the users its old and new references hold, and a change
 * of that table's user id (a contact re-linked to another login) bumps the
 * old and the new user.
 */
function memberUsersVersionSql(parts: Parts, bumpFor: string): string {
  const holders = new Map<
    string,
    { readonly table: string; readonly users: RoleKeys }
  >();
  for (const source of parts.sources) {
    const users = source.sql.userThrough;
    if (users !== undefined) {
      holders.set(
        JSON.stringify([
          tableKey(source.sql.table),
          tableKey(users.table),
          users.id,
          users.key,
          users.ref,
        ]),
        { table: source.sql.table, users },
      );
    }
  }
  if (holders.size === 0) {
    return "";
  }
  const byTable = new Map<
    string,
    { readonly table: string; readonly users: RoleKeys[] }
  >();
  for (const holder of holders.values()) {
    const key = tableKey(holder.table);
    const group = byTable.get(key);
    if (group === undefined) {
      byTable.set(key, { table: holder.table, users: [holder.users] });
    } else {
      group.users.push(holder.users);
    }
  }
  const memberBump = `${quoteIdent(parts.schema)}.permdock_bump_authz_version_member_users`;
  const linkedBump = `${quoteIdent(parts.schema)}.permdock_bump_authz_version_linked_users`;
  const groups = [...byTable];
  const lookup = (users: RoleKeys, indent: string): string =>
    `${indent}perform ${bumpFor}(array(
${indent}  select u.${quoteIdent(users.key)}::uuid from ${table(users.table)} u
${indent}  where ((tg_op <> 'INSERT' and u.${quoteIdent(users.id)} = old.${quoteIdent(users.ref)})
${indent}     or (tg_op <> 'DELETE' and u.${quoteIdent(users.id)} = new.${quoteIdent(users.ref)}))
${indent}    and ${signedUp(`u.${quoteIdent(users.key)}::uuid`)}
${indent}));`;
  const body = groups
    .map(([key, group]) => {
      if (groups.length === 1) {
        return group.users.map((users) => lookup(users, "  ")).join("\n");
      }
      const dot = key.indexOf(".");
      return `  if tg_table_schema = ${quoteLiteral(key.slice(0, dot))} and tg_table_name = ${quoteLiteral(key.slice(dot + 1))} then
${group.users.map((users) => lookup(users, "    ")).join("\n")}
  end if;`;
    })
    .join("\n");
  const memberTriggers = groups
    .map(([, group]) => {
      const target = table(group.table);
      return `drop trigger if exists ${quoteIdent(VERSION_TRIGGER)} on ${target};
create trigger ${quoteIdent(VERSION_TRIGGER)}
  after insert or update or delete on ${target}
  for each row execute function ${memberBump}();`;
    })
    .join("\n");
  const userTables = new Map<
    string,
    { readonly table: string; readonly key: string; readonly ids: Set<string> }
  >();
  for (const { users } of holders.values()) {
    const key = JSON.stringify([tableKey(users.table), users.key]);
    const entry = userTables.get(key) ?? {
      table: users.table,
      key: users.key,
      ids: new Set<string>(),
    };
    entry.ids.add(users.id);
    userTables.set(key, entry);
  }
  const userTriggers = [...userTables.values()]
    .map((entry) => {
      const target = table(entry.table);
      const name = quoteIdent(`${VERSION_TRIGGER}_${entry.key}`);
      const columns = [entry.key, ...entry.ids].map(quoteIdent).join(", ");
      return `drop trigger if exists ${name} on ${target};
create trigger ${name}
  after update of ${columns} or delete on ${target}
  for each row execute function ${linkedBump}(${quoteLiteral(entry.key)});`;
    })
    .join("\n");
  return `

-- a membership whose user id lives in another table bumps the users its old and new rows reference
create or replace function ${memberBump}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
${body}
  return null;
end;
$$;
revoke execute on function ${memberBump}() from public, anon, authenticated;
${memberTriggers}

-- re-linking that table's user id moves every membership that references the row: bump the old and the new user,
-- skipping a login being deleted (its version row goes with it)
create or replace function ${linkedBump}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
begin
  perform ${bumpFor}(array(
    select u
    from unnest(array[
      case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
      case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
    ]::uuid[]) u
    where ${signedUp("u")}
  ));
  return null;
end;
$$;
revoke execute on function ${linkedBump}() from public, anon, authenticated;
${userTriggers}`;
}

type RoleKeyHolder = {
  readonly table: string;
  readonly user: string;
  readonly userThrough?: RoleKeys;
  readonly through: RoleKeys;
};

/** Every table whose role column references a roles table: the global roles and the membership sources. */
function roleKeyHolders(parts: Parts): readonly RoleKeyHolder[] {
  const holders: RoleKeyHolder[] = [];
  if (parts.roles?.through !== undefined) {
    holders.push({
      table: parts.roles.table,
      user: parts.roles.user,
      through: parts.roles.through,
    });
  }
  for (const source of parts.sources) {
    for (const through of source.sql.throughs) {
      holders.push({
        table: source.sql.table,
        user: source.sql.user,
        ...(source.sql.userThrough === undefined
          ? {}
          : { userThrough: source.sql.userThrough }),
        through,
      });
    }
  }
  const seen = new Set<string>();
  return holders.filter((holder) => {
    const key = JSON.stringify([
      tableKey(holder.table),
      holder.user,
      holder.userThrough === undefined
        ? null
        : [
            tableKey(holder.userThrough.table),
            holder.userThrough.id,
            holder.userThrough.key,
          ],
      tableKey(holder.through.table),
      holder.through.id,
      holder.through.key,
      holder.through.ref,
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The bump for one roles table: unchanged keys and ids return early, else every holder of `old` is bumped. */
function roleKeysBumpSql(
  holders: readonly RoleKeyHolder[],
  versionTable: string,
  indent: string,
): string {
  const columns = [
    ...new Set(
      holders.flatMap((holder) => [holder.through.key, holder.through.id]),
    ),
  ];
  const unchanged = columns
    .map(
      (column) =>
        `new.${quoteIdent(column)} is not distinct from old.${quoteIdent(column)}`,
    )
    .join(`\n${indent}  and `);
  const selects = holders
    .map((holder) =>
      holder.userThrough === undefined
        ? `select h.${quoteIdent(holder.user)}::uuid as user_id from ${table(holder.table)} h where h.${quoteIdent(holder.through.ref)} = old.${quoteIdent(holder.through.id)}`
        : `select u.${quoteIdent(holder.userThrough.key)}::uuid as user_id from ${table(holder.table)} h join ${table(holder.userThrough.table)} u on u.${quoteIdent(holder.userThrough.id)} = h.${quoteIdent(holder.user)} where h.${quoteIdent(holder.through.ref)} = old.${quoteIdent(holder.through.id)}`,
    )
    .join(`\n${indent}  union\n${indent}  `);
  return `${indent}if tg_op = 'UPDATE'
${indent}  and ${unchanged} then
${indent}  return null;
${indent}end if;
${indent}insert into ${versionTable} as v (user_id, version)
${indent}select distinct h.user_id, 1
${indent}from (
${indent}  ${selects}
${indent}) h
${indent}where h.user_id is not null
${indent}  and exists (select 1 from auth.users au where au.id = h.user_id)
${indent}on conflict (user_id) do update set version = v.version + 1;`;
}

/**
 * A renamed role key changes the `roles` claim of everyone who holds it and
 * the `roles` of every membership that references it, so updates to a roles
 * table bump each holder.
 */
function roleKeysVersionSql(parts: Parts, versionTable: string): string {
  const holders = roleKeyHolders(parts);
  if (holders.length === 0) {
    return "";
  }
  const byTable = new Map<
    string,
    { readonly table: string; readonly holders: RoleKeyHolder[] }
  >();
  for (const holder of holders) {
    const key = tableKey(holder.through.table);
    const group = byTable.get(key);
    if (group === undefined) {
      byTable.set(key, { table: holder.through.table, holders: [holder] });
    } else {
      group.holders.push(holder);
    }
  }
  const bump = `${quoteIdent(parts.schema)}.permdock_bump_authz_version_role_keys`;
  const groups = [...byTable];
  const body = groups
    .map(([key, group]) => {
      if (groups.length === 1) {
        return roleKeysBumpSql(group.holders, versionTable, "  ");
      }
      const dot = key.indexOf(".");
      return `  if tg_table_schema = ${quoteLiteral(key.slice(0, dot))} and tg_table_name = ${quoteLiteral(key.slice(dot + 1))} then
${roleKeysBumpSql(group.holders, versionTable, "    ")}
  end if;`;
    })
    .join("\n");
  const triggers = groups
    .map(([, group]) => {
      const target = table(group.table);
      return `drop trigger if exists ${quoteIdent(VERSION_TRIGGER)} on ${target};
create trigger ${quoteIdent(VERSION_TRIGGER)}
  after update or delete on ${target}
  for each row execute function ${bump}();`;
    })
    .join("\n");
  return `

-- a renamed role key changes the roles of everyone who holds it, globally or through a membership
create or replace function ${bump}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
${body}
  return null;
end;
$$;
revoke execute on function ${bump}() from public, anon, authenticated;
${triggers}`;
}

/**
 * Fails the migration when a client role can write an `attrs` column: a
 * claim the user can set is not a server-owned attribute.
 */
function attrsGuardSql(plan: AttrsPlan | undefined): string {
  if (plan?.table === undefined || plan.columns.length === 0) {
    return "";
  }
  const target = quoteLiteral(table(plan.table));
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

function managedSql(parts: Parts): string {
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
      ) => `drop trigger if exists ${quoteIdent(MANAGED_TRIGGER)} on ${table(source.sql.table)};
create trigger ${quoteIdent(MANAGED_TRIGGER)}
  before insert or update or delete on ${table(source.sql.table)}
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
function configToml(schema: string, jwtExpiry: number): string {
  return `[auth]
jwt_expiry = ${String(jwtExpiry)}

[auth.hook.custom_access_token]
enabled = true
uri = "${hookUri(schema)}"`;
}

const BUDGET_MEASURE =
  "octet_length(memberships::text) + octet_length(attrs::text)";

type HookOverrides = {
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly schema?: string;
};

function hookParts(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides,
): Parts {
  const hook = config.supabase?.hook;
  if (hook === undefined) {
    throw new Error(
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
          ),
    active: activeFromSql(overrides.activeFrom ?? hook.activeFrom, root),
    attrs: hook.attrs === undefined ? undefined : attrsPlan(hook.attrs),
    extra: extraPlan.claims,
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
    throw new Error(`PermDock CLI: ${parts.attrs.errors.join("; ")}`);
  }
  if (extraPlan.errors.length > 0) {
    throw new Error(`PermDock CLI: ${extraPlan.errors.join("; ")}`);
  }
  quoteIdent(parts.tenantClaim);
  return parts;
}

function permdockClaim(name: string, budget = false): SupabaseHookClaim {
  return { name, source: "permdock", budget };
}

function hookClaims(parts: Parts): readonly SupabaseHookClaim[] {
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

function helperList(
  parts: Parts,
  types: ReadonlyMap<string, string>,
): readonly SupabaseManifestHelper[] {
  const client = ["authenticated"];
  return [
    {
      name: "permdock_has",
      args: "p_grant text",
      returns: "boolean",
      execute: client,
    },
    ...parts.scopes.flatMap((scope): SupabaseManifestHelper[] => {
      const returns = `setof ${types.get(scope.name) ?? "uuid"}`;
      return [
        {
          name: `permitted_${scope.name}_ids`,
          args: "p_grant text",
          returns,
          execute: client,
        },
        {
          name: memberIdsHelper(scope.name),
          args: "",
          returns,
          execute: client,
        },
        ...(parts.helpers.memberFor.includes(scope.name)
          ? [
              {
                name: memberForHelper(scope.name),
                args: "p_user uuid",
                returns,
                execute:
                  parts.extra.length === 0 ? [] : ["supabase_auth_admin"],
              },
            ]
          : []),
      ];
    }),
  ];
}

function manifestOf(
  parts: Parts,
  out: string,
  config: PermDockConfig,
): SupabaseHookManifest {
  const rls = config.rls;
  const ctx: RlsSqlContext = {
    dialect: "supabase",
    scopes: parts.scopes,
    tenantClaim: parts.tenantClaim,
    gucPrefix: rls?.gucPrefix ?? "app",
    tenantType: rls?.tenantType ?? "uuid",
    ...(rls?.teamType === undefined ? {} : { teamType: rls.teamType }),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
  };
  const types = new Map(
    parts.scopes.map((scope) => [scope.name, scopeTypeOf(ctx, scope.name)]),
  );
  const helpers = helperList(parts, types);
  return {
    $schema: SUPABASE_MANIFEST_SCHEMA,
    version: 1,
    hook: { schema: parts.schema, function: "custom_access_token_hook", out },
    helpers: {
      schema: parts.helpers.schema,
      functions: helpers.map((helper) => helper.name),
    },
    tenantClaim: parts.tenantClaim,
    budget: { bytes: parts.budget, measure: BUDGET_MEASURE },
    claims: hookClaims(parts),
    authzVersion: parts.version,
    ...(parts.version
      ? {
          authzVersionBump: {
            schema: parts.schema,
            function: AUTHZ_VERSION_BUMP,
            args: "p_users uuid[]",
          },
        }
      : {}),
    memberships: parts.sources.map((source) => source.sql.manifest),
    rls: {
      schema: parts.helpers.schema,
      mode: resolveAuthorize(config),
      tenantClaim: parts.tenantClaim,
      scopes: parts.scopes.map((scope) => ({
        name: scope.name,
        type: types.get(scope.name) ?? "uuid",
        ...(scope.within === undefined ? {} : { within: scope.within }),
      })),
      helpers,
      memberships: parts.helpers.memberships,
    },
    decidingColumns: decidingColumns(
      config,
      parts.attrs === undefined
        ? undefined
        : {
            ...(parts.attrs.table === undefined
              ? {}
              : { table: parts.attrs.table }),
            columns: parts.attrs.columns,
          },
    ),
    markers: { hook: "v1", grants: "v1" },
  };
}

/** The first line of the generated hook: fields `--check` compares before the full text. */
function hookMarker(manifest: SupabaseHookManifest): string {
  return `${HOOK_MARKER} schema=${manifest.hook.schema} tenant=${manifest.tenantClaim} budget=${String(manifest.budget.bytes)} claims=${manifest.claims.map((claim) => claim.name).join(",")}`;
}

function defaultOut(config: PermDockConfig): string {
  return config.supabase?.hook?.out ?? "supabase/permdock-hook.sql";
}

/** `supabase.hook.out`, else pg-delta's per-schema path, else `supabase/permdock-hook.sql`. */
export function hookOut(
  cwd: string,
  config: PermDockConfig,
  schema?: string,
): string {
  const pgDelta = supabaseConfig(cwd).pgDelta;
  return config.supabase?.hook?.out !== undefined || pgDelta === undefined
    ? defaultOut(config)
    : pgDeltaPath(
        pgDelta.schemaDir,
        "hook",
        schema ??
          config.supabase?.hook?.schema ??
          config.rls?.schema ??
          PERMDOCK_SCHEMA,
      );
}

export function supabaseHookManifest(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides & { readonly out?: string } = {},
): SupabaseHookManifest {
  const parts = hookParts(scopes, config, overrides);
  return manifestOf(parts, overrides.out ?? defaultOut(config), config);
}

/**
 * The hook migration. With `grantsOut`, the `supabase_auth_admin` grants are
 * left out of `sql` and returned in `grants` for that file.
 */
export function supabaseHookSql(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides = {},
  grantsOut?: string,
): {
  readonly sql: string;
  readonly grants: string;
  readonly manifest: SupabaseHookManifest;
} {
  const parts = hookParts(scopes, config, overrides);
  const manifest = manifestOf(parts, defaultOut(config), config);
  const toml = configToml(parts.schema, parts.jwtExpiry)
    .split("\n")
    .map((line) => (line === "" ? "--" : `--   ${line}`))
    .join("\n");
  const sql = [
    `${hookMarker(manifest)}
-- custom_access_token_hook(jsonb): memberships go active ${parts.root} first and stop at the budget
-- supabase/config.toml:
${toml}${grantsOut === undefined ? "" : `\n-- the supabase_auth_admin grants are in ${grantsOut}`}`,
    attrsGuardSql(parts.attrs),
    hookSql(parts),
    versionSql(parts),
    grantsOut === undefined ? grantsSql(parts) : "",
    managedSql(parts),
  ]
    .filter((chunk) => chunk !== "")
    .join("\n\n");
  const grants = `${GRANTS_MARKER} schema=${parts.schema}
${grantsSql(parts)}
`;
  return { sql: `${sql}\n`, grants, manifest };
}

/** What the hook file's header says about where its grants went. */
export function grantsLabel(grantsOut: string | undefined): string | undefined {
  if (grantsOut === undefined) {
    return undefined;
  }
  return grantsOut === STDOUT ? "a separate migration" : grantsOut;
}

function markerDrift(
  onDisk: string,
  expected: SupabaseHookManifest,
  outRel: string,
): string {
  const found = hookMarkerFields(onDisk);
  if (found === undefined) {
    return `supabase hook drift: ${outRel} has no ${HOOK_MARKER} line`;
  }
  const want = hookMarkerFields(hookMarker(expected)) ?? {};
  const changed = Object.keys(want)
    .filter((key) => found[key] !== want[key])
    .map((key) => `${key} ${found[key] ?? "(none)"} -> ${want[key] ?? ""}`);
  return changed.length === 0
    ? "supabase hook drift"
    : `supabase hook drift: ${changed.join("; ")}`;
}

function inspectText(manifest: SupabaseHookManifest): string {
  return [
    `hook ${manifest.hook.schema}.${manifest.hook.function} (${manifest.hook.out})`,
    `helpers ${manifest.helpers.functions.map((fn) => `${manifest.helpers.schema}.${fn}`).join(", ")}`,
    `tenant claim ${manifest.tenantClaim}`,
    `budget ${String(manifest.budget.bytes)} bytes of ${manifest.budget.measure}`,
    `claims ${manifest.claims.map((claim) => `${claim.name}${claim.source === "permdock" ? "" : ` (${claim.source})`}${claim.budget ? " [budget]" : ""}`).join(", ")}`,
    `authz_ver ${manifest.authzVersion ? "on" : "off"}`,
  ].join("\n");
}

/**
 * Writes the manifest to `rel`, or with `check` compares it as JSON, so a
 * formatter that reflows the file is not drift.
 */
function manifestFile(
  cwd: string,
  rel: string,
  manifest: SupabaseHookManifest,
  check: boolean,
): { readonly code: 0 | 1; readonly output: string } {
  const path = resolve(cwd, rel);
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return { code: 0, output: `wrote ${rel}` };
  }
  if (!existsSync(path)) {
    return { code: 1, output: `supabase manifest drift: missing ${rel}` };
  }
  let onDisk: unknown;
  try {
    onDisk = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { code: 1, output: `supabase manifest drift: ${rel} is not JSON` };
  }
  const found: Record<string, unknown> =
    typeof onDisk === "object" && onDisk !== null && !Array.isArray(onDisk)
      ? Object.fromEntries(Object.entries(onDisk))
      : {};
  const changed = [
    ...new Set([...Object.keys(manifest), ...Object.keys(found)]),
  ].filter(
    (key) =>
      JSON.stringify(Reflect.get(manifest, key)) !== JSON.stringify(found[key]),
  );
  return changed.length === 0
    ? { code: 0, output: "supabase manifest up to date" }
    : {
        code: 1,
        output: `supabase manifest drift: ${rel} differs in ${changed.join(", ")}; run permdock supabase inspect --out ${rel}`,
      };
}

export async function loadScopes(
  cwd: string,
  config: PermDockConfig,
): Promise<readonly Scope[]> {
  if (config.policy === undefined) {
    throw new Error(
      "PermDock CLI: supabase hook generate needs policy in permdock.config.ts",
    );
  }
  const policy = asPolicy(
    pickNamed(await loadModule(resolve(cwd, config.policy)), ["policy"]),
  );
  return scopeList(policy.scopes);
}

export async function runSupabase(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  /** `true` for a bare `--out`. */
  readonly out?: string | true;
  readonly check: boolean;
  readonly json?: boolean;
  readonly db?: string;
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly schema?: string;
  readonly grantsOut?: string;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const [area, action] = input.rest;
  const overrides: HookOverrides = Object.fromEntries(
    Object.entries({
      activeFrom: input.activeFrom,
      budget: input.budget,
      schema: input.schema,
    }).filter(([, value]) => value !== undefined),
  );
  if (area === "inspect" && action === undefined) {
    const scopes = await loadScopes(input.cwd, input.config);
    const manifest = supabaseHookManifest(scopes, input.config, {
      ...overrides,
      out: hookOut(input.cwd, input.config, input.schema),
    });
    if (input.out !== undefined || input.check) {
      return manifestFile(
        input.cwd,
        typeof input.out === "string" ? input.out : MANIFEST_FILE,
        manifest,
        input.check,
      );
    }
    return {
      code: 0,
      output:
        input.json === true
          ? JSON.stringify(manifest, null, 2)
          : inspectText(manifest),
    };
  }
  if (area !== "hook" || action !== "generate") {
    return { code: 2, output: SUPABASE_HELP };
  }
  const scopes = await loadScopes(input.cwd, input.config);
  const { sql, grants, manifest } = supabaseHookSql(
    scopes,
    input.config,
    overrides,
    grantsLabel(input.grantsOut),
  );
  const outRel =
    typeof input.out === "string"
      ? input.out
      : hookOut(input.cwd, input.config, input.schema);
  const outPath = resolve(input.cwd, outRel);
  const hook = input.config.supabase?.hook;
  const grantsFile: readonly SqlFile[] =
    input.grantsOut === undefined
      ? []
      : [{ part: "grants", rel: input.grantsOut, text: grants }];
  const toml = configToml(
    input.schema ?? hook?.schema ?? input.config.rls?.schema ?? PERMDOCK_SCHEMA,
    hook?.jwtExpiry ?? 900,
  );
  if (input.check) {
    if (!existsSync(outPath)) {
      return { code: 1, output: `supabase hook drift: missing ${outRel}` };
    }
    const onDisk = readFileSync(outPath, "utf8");
    if (onDisk !== sql) {
      return { code: 1, output: markerDrift(onDisk, manifest, outRel) };
    }
    const drift = driftOf(input.cwd, grantsFile);
    return drift.length === 0
      ? { code: 0, output: "supabase hook up to date" }
      : { code: 1, output: `supabase hook drift: ${drift.join("; ")}` };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sql);
  const grantsWritten = writeSqlFiles(input.cwd, grantsFile);
  const placed = { ...manifest, hook: { ...manifest.hook, out: outRel } };
  const missing =
    input.db === undefined
      ? missingHelpersInFiles(input.cwd, input.config, placed)
      : await missingHelpersInDb(input.db, placed);
  return {
    code: 0,
    output: [
      `wrote ${[outRel, ...grantsWritten.wrote].join(", ")}`,
      ...(grantsWritten.printed === "" ? [] : [grantsWritten.printed]),
      "add to supabase/config.toml:",
      toml,
      ...(missing.length === 0 ? [] : [missingHelpersMessage(placed, missing)]),
    ].join("\n"),
  };
}
