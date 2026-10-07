import type { RlsSqlContext } from "./rls-sql.ts";
import type { RlsApprovalsAdopt } from "./types.ts";

import { APPROVAL_REQUEST_SCHEMA } from "./approval-schema.ts";
import { qualified } from "./rls-helpers.ts";
import {
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "./rls-sql.ts";

/** The objects `rls.approvals` adds. Names are part of the SQL contract `supabaseApprovalStore` calls. */
const APPROVAL_STORE = {
  table: "approval_requests",
  open: "permdock_approval_open",
  get: "permdock_approval_get",
  resolve: "permdock_approval_resolve",
  consume: "permdock_approval_consume",
  list: "permdock_approval_list",
  expire: "permdock_approval_expire",
  cancel: "permdock_approval_cancel",
} as const;

/** `body` as the row's filter columns hold it. */
const COLUMNS = `p_request ->> 'token',
    p_request,
    p_request ->> 'status',
    p_request #>> '{subject,principal,tenant}',
    p_request #>> '{subject,principal,id}',
    p_request #>> '{subject,actor,id}',
    p_request #>> '{subject,session}',
    coalesce(jsonb_array_length(p_request -> 'approvals'), 0),
    p_request ->> 'createdAt',
    (p_request ->> 'expiresAt')::timestamptz,
    (p_request ->> 'consumedAt')::timestamptz`;

/** The `ApprovalListFilter` in `p_filter`, over the row aliased `a`. */
const FILTER = `(p_filter ->> 'status' is null or a.status = p_filter ->> 'status')
    and (p_filter ->> 'tenant' is null or a.tenant = p_filter ->> 'tenant')
    and (p_filter ->> 'principalId' is null or a.principal_id = p_filter ->> 'principalId')
    and (p_filter ->> 'actorId' is null or a.actor_id = p_filter ->> 'actorId')
    and (p_filter ->> 'session' is null or a.session = p_filter ->> 'session')`;

function serverOnly(fn: string, args: string): string {
  return `revoke execute on function ${fn}(${args}) from public, anon, authenticated;`;
}

const BODY_CHECK = `${APPROVAL_STORE.table}_body_schema`;

/**
 * `rls.jsonSchema`: a pg_jsonschema check that `body` matches
 * `approval-request-v1.json`, added `not valid` and then validated. `auto`
 * adds it only where the extension is available.
 */
function bodySchemaSql(
  table: string,
  mode: "auto" | true,
  body = "body",
  check = BODY_CHECK,
): string {
  const statements = [
    "create schema if not exists extensions;",
    "create extension if not exists pg_jsonschema with schema extensions;",
    `alter table ${table} drop constraint if exists "${check}";`,
    `alter table ${table} add constraint "${check}" check (extensions.jsonb_matches_schema(${quoteLiteral(JSON.stringify(APPROVAL_REQUEST_SCHEMA))}::json, ${body})) not valid;`,
    `alter table ${table} validate constraint "${check}";`,
  ];
  const comment =
    "-- approval store: body matches schemas/approval-request-v1.json through pg_jsonschema";
  if (mode === true) {
    return `\n${comment}\n${statements.join("\n")}\n`;
  }
  return `\n${comment}, where the extension is available
do $permdock$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_jsonschema') then
${statements.map((statement) => `    ${statement}`).join("\n")}
  end if;
end
$permdock$;\n`;
}

/**
 * The approval store (`rls.approvals`): one table of `ApprovalRequest`
 * bodies with the columns a list filters on, and one `security definer`
 * function per `ApprovalStore` method, each one atomic statement. No client
 * role may read the table or execute the functions: approvals are opened and
 * resolved by the server, which grants its own role.
 */
export function approvalStoreSql(
  ctx: RlsSqlContext,
  jsonSchema: "auto" | boolean = false,
): string {
  const table = qualified(ctx, APPROVAL_STORE.table);
  const fn = (name: string): string => qualified(ctx, name);
  const index = (name: string): string => `"${APPROVAL_STORE.table}_${name}"`;
  return `-- approval store: ApprovalRequest bodies, opened, resolved and consumed through the functions below; supabaseApprovalStore calls them
create table if not exists ${table} (
  token text primary key,
  body jsonb not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  tenant text,
  principal_id text,
  actor_id text,
  session text,
  approvals integer not null default 0,
  created_at text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists ${index("page")} on ${table} (created_at collate "C", token collate "C");
create index if not exists ${index("pending")} on ${table} (status, expires_at);
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;
${jsonSchema === false ? "" : bodySchemaSql(table, jsonSchema)}
-- open a request; a repeated ask keeps the open record and replaces only an expired one
create or replace function ${fn(APPROVAL_STORE.open)}(p_request jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into ${table} as a (token, body, status, tenant, principal_id, actor_id, session, approvals, created_at, expires_at, consumed_at)
  values (
    ${COLUMNS}
  )
  on conflict (token) do update
    set body = excluded.body, status = excluded.status, tenant = excluded.tenant,
      principal_id = excluded.principal_id, actor_id = excluded.actor_id, session = excluded.session,
      approvals = excluded.approvals, created_at = excluded.created_at,
      expires_at = excluded.expires_at, consumed_at = excluded.consumed_at
    where a.status = 'expired' or a.expires_at <= now()
$$;
${serverOnly(fn(APPROVAL_STORE.open), "jsonb")}

create or replace function ${fn(APPROVAL_STORE.get)}(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.body from ${table} a where a.token = p_token
$$;
${serverOnly(fn(APPROVAL_STORE.get), "text")}

-- write a verdict over the record it was computed from: still pending, unexpired, with p_seen approvals
create or replace function ${fn(APPROVAL_STORE.resolve)}(p_token text, p_next jsonb, p_seen integer)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update ${table} a
  set body = p_next,
    status = p_next ->> 'status',
    approvals = coalesce(jsonb_array_length(p_next -> 'approvals'), 0)
  where a.token = p_token
    and a.status = 'pending'
    and a.expires_at > now()
    and a.approvals = p_seen
  returning a.body
$$;
${serverOnly(fn(APPROVAL_STORE.resolve), "text, jsonb, integer")}

-- consume an approved, unexpired, unconsumed request once
create or replace function ${fn(APPROVAL_STORE.consume)}(p_token text, p_now text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update ${table} a
  set consumed_at = p_now::timestamptz,
    body = a.body || jsonb_build_object('consumedAt', p_now)
  where a.token = p_token
    and a.status = 'approved'
    and a.consumed_at is null
    and a.expires_at > p_now::timestamptz
  returning a.body
$$;
${serverOnly(fn(APPROVAL_STORE.consume), "text, text")}

-- one page in (createdAt, token) order after the cursor position
create or replace function ${fn(APPROVAL_STORE.list)}(p_filter jsonb, p_after_created text, p_after_token text, p_limit integer)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.body
  from ${table} a
  where ${FILTER}
    and (p_after_created is null
      or (a.created_at collate "C", a.token collate "C") > (p_after_created collate "C", p_after_token collate "C"))
  order by a.created_at collate "C", a.token collate "C"
  limit p_limit
$$;
${serverOnly(fn(APPROVAL_STORE.list), "jsonb, text, text, integer")}

create or replace function ${fn(APPROVAL_STORE.expire)}(p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update ${table} a
    set status = 'expired', body = a.body || '{"status":"expired"}'::jsonb
    where a.status = 'pending' and a.expires_at <= p_now::timestamptz
    returning 1
  )
  select count(*)::integer from expired
$$;
${serverOnly(fn(APPROVAL_STORE.expire), "text")}

-- reject every pending request the filter matches, as system:<by>
create or replace function ${fn(APPROVAL_STORE.cancel)}(p_filter jsonb, p_by text, p_note text, p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with cancelled as (
    update ${table} a
    set status = 'rejected',
      body = (a.body - 'note') || jsonb_strip_nulls(jsonb_build_object(
        'status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note
      ))
    where a.status = 'pending'
      and ${FILTER.replaceAll("\n    ", "\n      ")}
    returning 1
  )
  select count(*)::integer from cancelled
$$;
${serverOnly(fn(APPROVAL_STORE.cancel), "jsonb, text, text, text")}
`;
}

/** The request fields an adopted table may mirror into its own columns, as SQL over a body. */
const MIRRORS = {
  status: (body: string) => `${body} ->> 'status'`,
  permission: (body: string) => `${body} ->> 'permission'`,
  tenant: (body: string) => `${body} #>> '{subject,principal,tenant}'`,
  principalId: (body: string) => `${body} #>> '{subject,principal,id}'`,
  actorId: (body: string) => `${body} #>> '{subject,actor,id}'`,
  session: (body: string) => `${body} #>> '{subject,session}'`,
  approvals: (body: string) =>
    `coalesce(jsonb_array_length(${body} -> 'approvals'), 0)`,
  createdAt: (body: string) => `${body} ->> 'createdAt'`,
  expiresAt: (body: string) => `${body} ->> 'expiresAt'`,
  resolvedAt: (body: string) => `${body} ->> 'resolvedAt'`,
  resolvedBy: (body: string) => `${body} ->> 'resolvedBy'`,
  consumedAt: (body: string) => `${body} ->> 'consumedAt'`,
} as const satisfies Record<
  keyof NonNullable<RlsApprovalsAdopt["mirror"]>,
  (body: string) => string
>;

type Mirror = readonly (readonly [
  column: string,
  field: keyof typeof MIRRORS,
])[];

function mirrorsOf(adopt: RlsApprovalsAdopt): Mirror {
  const out: [string, keyof typeof MIRRORS][] = [];
  for (const [field, column] of Object.entries(adopt.mirror ?? {})) {
    if (!Object.hasOwn(MIRRORS, field)) {
      throw new Error(
        `PermDock CLI: rls.approvals.mirror.${field} is not a request field; use ${Object.keys(MIRRORS).join(", ")}`,
      );
    }
    if (typeof column !== "string") {
      throw new TypeError(
        `PermDock CLI: rls.approvals.mirror.${field} must be a column name`,
      );
    }
    // SAFETY: Object.hasOwn checked the field is a key of MIRRORS above.
    out.push([column, field as keyof typeof MIRRORS]);
  }
  return out;
}

/** One row of `table` from `values` (column, SQL), each converted to the column's own type. */
function populate(
  table: string,
  values: readonly (readonly [column: string, sql: string])[],
): string {
  const object = values
    .map(([column, sql]) => `${quoteLiteral(column)}, ${sql}`)
    .join(", ");
  return `pg_catalog.jsonb_populate_record(null::${table}, pg_catalog.jsonb_build_object(${object}))`;
}

/** The mirrored columns' values for the request `body`. */
function mirrorRow(table: string, mirror: Mirror, body: string): string {
  return populate(
    table,
    mirror.map(([column, field]) => [column, MIRRORS[field](body)] as const),
  );
}

/** `, (<mirrored columns>) = (select …)` for an update that writes `body`; empty without mirrors. */
function mirrorSet(table: string, mirror: Mirror, body: string): string {
  if (mirror.length === 0) {
    return "";
  }
  const columns = mirror.map(([column]) => quoteIdent(column));
  const picked = columns.map((column) => `r.${column}`).join(", ");
  const target =
    columns.length === 1 ? (columns[0] ?? "") : `(${columns.join(", ")})`;
  return `,\n    ${target} = (select ${picked} from ${mirrorRow(table, mirror, body)} r)`;
}

/**
 * The approval store over a table the app already has (`rls.approvals:
 * { table, token?, body?, mirror? }`): the same `permdock_approval_*`
 * functions, reading every field from the request body in `body`, keyed by
 * the text column `token`, and copying the fields `mirror` names into the
 * app's own columns, converted to their types, on every write. The table's
 * grants and policies stay the app's.
 */
export function adoptedApprovalStoreSql(
  ctx: RlsSqlContext,
  adopt: RlsApprovalsAdopt,
  jsonSchema: "auto" | boolean = false,
): string {
  const table = quoteTable(qualifiedTable(adopt.table));
  const base = adopt.table.split(".").at(-1) ?? adopt.table;
  const token = quoteIdent(adopt.token ?? "token");
  const body = quoteIdent(adopt.body ?? "body");
  const mirror = mirrorsOf(adopt);
  for (const [column] of mirror) {
    if (
      column === (adopt.token ?? "token") ||
      column === (adopt.body ?? "body")
    ) {
      throw new Error(
        `PermDock CLI: rls.approvals.mirror names the ${column} column, which already holds the token or the body`,
      );
    }
  }
  const open = adopt.open ?? "insert";
  if (open !== "insert" && open !== "attach") {
    throw new Error(
      `PermDock CLI: rls.approvals.open must be 'insert' or 'attach', got '${String(open)}'`,
    );
  }
  const schema = adopt.schema;
  if (schema !== undefined && (typeof schema !== "string" || schema === "")) {
    throw new Error("PermDock CLI: rls.approvals.schema must be a schema name");
  }
  const fn = (name: string): string =>
    schema === undefined
      ? qualified(ctx, name)
      : `${quoteIdent(schema)}.${name}`;
  const index = (name: string): string =>
    quoteIdent(`${base}_permdock_${name}`);
  const status = `a.${body} ->> 'status'`;
  const expires = `(a.${body} ->> 'expiresAt')::timestamptz`;
  const created = `(a.${body} ->> 'createdAt')`;
  const filter = `(p_filter ->> 'status' is null or ${status} = p_filter ->> 'status')
    and (p_filter ->> 'tenant' is null or a.${body} #>> '{subject,principal,tenant}' = p_filter ->> 'tenant')
    and (p_filter ->> 'principalId' is null or a.${body} #>> '{subject,principal,id}' = p_filter ->> 'principalId')
    and (p_filter ->> 'actorId' is null or a.${body} #>> '{subject,actor,id}' = p_filter ->> 'actorId')
    and (p_filter ->> 'session' is null or a.${body} #>> '{subject,session}' = p_filter ->> 'session')`;
  const columns = [
    token,
    body,
    ...mirror.map(([column]) => quoteIdent(column)),
  ];
  const inserted = populate(table, [
    [adopt.token ?? "token", "p_request ->> 'token'"],
    [adopt.body ?? "body", "p_request"],
    ...mirror.map(
      ([column, field]) => [column, MIRRORS[field]("p_request")] as const,
    ),
  ]);
  const insertSql = `-- open a request; a repeated ask keeps the open record and replaces only an expired one
create or replace function ${fn(APPROVAL_STORE.open)}(p_request jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into ${table} as a (${columns.join(", ")})
  select ${columns.map((column) => `r.${column}`).join(", ")}
  from ${inserted} r
  on conflict (${token}) do update
    set ${columns
      .filter((column) => column !== token)
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}
    where ${status} = 'expired' or ${expires} <= now()
$$;`;
  const attachSql = `create or replace function ${fn(APPROVAL_STORE.open)}(p_request jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update ${table} a
  set ${body} = p_request${mirrorSet(table, mirror, "p_request")}
  where a.${token} = p_request ->> 'token'
    and (a.${body} is null or ${status} = 'expired' or ${expires} <= now());
  if not found and not exists (select 1 from ${table} a where a.${token} = p_request ->> 'token') then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no row of ${adopt.table.replaceAll("'", "''")} holds approval token ' || (p_request ->> 'token'),
      hint = 'insert the application row with this token before opening the request';
  end if;
end;
$$;`;
  return `-- approval store adopted onto ${adopt.table}: ApprovalRequest bodies in ${adopt.body ?? "body"}, keyed by ${adopt.token ?? "token"}; supabaseApprovalStore calls the functions below
alter table ${table} add column if not exists ${token} text;
alter table ${table} add column if not exists ${body} jsonb;
create unique index if not exists ${index("token")} on ${table} (${token});
create index if not exists ${index("page")} on ${table} ((${body} ->> 'createdAt') collate "C", ${token} collate "C");
create index if not exists ${index("status")} on ${table} ((${body} ->> 'status'));
${jsonSchema === false ? "" : bodySchemaSql(table, jsonSchema, body, `${base}_permdock_body_schema`)}
${open === "attach" ? attachSql : insertSql}
${serverOnly(fn(APPROVAL_STORE.open), "jsonb")}

create or replace function ${fn(APPROVAL_STORE.get)}(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.${body} from ${table} a where a.${token} = p_token
$$;
${serverOnly(fn(APPROVAL_STORE.get), "text")}

-- write a verdict over the record it was computed from: still pending, unexpired, with p_seen approvals
create or replace function ${fn(APPROVAL_STORE.resolve)}(p_token text, p_next jsonb, p_seen integer)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update ${table} a
  set ${body} = p_next${mirrorSet(table, mirror, "p_next")}
  where a.${token} = p_token
    and ${status} = 'pending'
    and ${expires} > now()
    and coalesce(jsonb_array_length(a.${body} -> 'approvals'), 0) = p_seen
  returning a.${body}
$$;
${serverOnly(fn(APPROVAL_STORE.resolve), "text, jsonb, integer")}

-- consume an approved, unexpired, unconsumed request once
create or replace function ${fn(APPROVAL_STORE.consume)}(p_token text, p_now text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update ${table} a
  set ${body} = a.${body} || jsonb_build_object('consumedAt', p_now)${mirrorSet(table, mirror, `(a.${body} || jsonb_build_object('consumedAt', p_now))`)}
  where a.${token} = p_token
    and ${status} = 'approved'
    and a.${body} ->> 'consumedAt' is null
    and ${expires} > p_now::timestamptz
  returning a.${body}
$$;
${serverOnly(fn(APPROVAL_STORE.consume), "text, text")}

-- one page in (createdAt, token) order after the cursor position
create or replace function ${fn(APPROVAL_STORE.list)}(p_filter jsonb, p_after_created text, p_after_token text, p_limit integer)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.${body}
  from ${table} a
  where a.${body} is not null
    and ${filter}
    and (p_after_created is null
      or (${created} collate "C", a.${token} collate "C") > (p_after_created collate "C", p_after_token collate "C"))
  order by ${created} collate "C", a.${token} collate "C"
  limit p_limit
$$;
${serverOnly(fn(APPROVAL_STORE.list), "jsonb, text, text, integer")}

create or replace function ${fn(APPROVAL_STORE.expire)}(p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update ${table} a
    set ${body} = a.${body} || '{"status":"expired"}'::jsonb${mirrorSet(table, mirror, `(a.${body} || '{"status":"expired"}'::jsonb)`)}
    where ${status} = 'pending' and ${expires} <= p_now::timestamptz
    returning 1
  )
  select count(*)::integer from expired
$$;
${serverOnly(fn(APPROVAL_STORE.expire), "text")}

-- reject every pending request the filter matches, as system:<by>
create or replace function ${fn(APPROVAL_STORE.cancel)}(p_filter jsonb, p_by text, p_note text, p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with cancelled as (
    update ${table} a
    set ${body} = (a.${body} - 'note') || jsonb_strip_nulls(jsonb_build_object(
        'status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note
      ))${mirrorSet(
        table,
        mirror,
        `((a.${body} - 'note') || jsonb_strip_nulls(jsonb_build_object('status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note)))`,
      )}
    where ${status} = 'pending'
      and ${filter.replaceAll("\n    ", "\n      ")}
    returning 1
  )
  select count(*)::integer from cancelled
$$;
${serverOnly(fn(APPROVAL_STORE.cancel), "jsonb, text, text, text")}
`;
}
