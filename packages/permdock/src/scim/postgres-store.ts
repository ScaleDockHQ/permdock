import type { AppData } from "../core/app-data.ts";

import { compact, isRecord } from "../core/compact.ts";
import { type SqlQuery, quoteSqlIdent, sqlRows } from "../core/sql.ts";
import { isoNow } from "../core/time.ts";
import { applyGroupOp, applyUserOp, emailsOf } from "./store.ts";
import {
  DirectoryNotFoundError,
  DirectoryUniquenessError,
  type DirectoryGroup,
  type DirectoryStore,
  type DirectoryUser,
  type ScimFilter,
  type ScimPage,
  type ScimPageResult,
  type ScimPatchOp,
} from "./types.ts";

/** The tables `permdock scim generate` writes; their names are the contract this store reads. */
export const SCIM_TABLES = {
  users: "scim_users",
  groups: "scim_groups",
  members: "scim_group_members",
} as const;

/** The constraints whose violation is a SCIM `409 uniqueness`, by the attribute they cover. */
export const SCIM_UNIQUE = {
  userName: "scim_users_user_name_key",
  userExternalId: "scim_users_external_id_key",
  groupExternalId: "scim_groups_external_id_key",
} as const;

export const SCIM_SCHEMA = "permdock";

export type PostgresDirectoryStoreOptions = {
  /** Schema of the generated tables (`permdock scim generate --schema`). Default `permdock`. */
  readonly schema?: string;
};

const DEFAULT_COUNT = 100;
/** A PATCH re-reads and retries when another write changed the row in between. */
const PATCH_ATTEMPTS = 8;

const iso = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function userJson(alias: string): string {
  return `jsonb_build_object(
    'id', ${alias}.id, 'userName', ${alias}.user_name, 'externalId', ${alias}.external_id,
    'active', ${alias}.active, 'emails', ${alias}.emails, 'x', ${alias}.x,
    'created', ${iso(`${alias}.created_at`)}, 'lastModified', ${iso(`${alias}.updated_at`)},
    'revision', ${alias}.revision)`;
}

function groupJson(alias: string, members: string): string {
  return `jsonb_build_object(
    'id', ${alias}.id, 'displayName', ${alias}.display_name, 'externalId', ${alias}.external_id,
    'roles', to_jsonb(${alias}.roles), 'x', ${alias}.x, 'members', ${members},
    'created', ${iso(`${alias}.created_at`)}, 'lastModified', ${iso(`${alias}.updated_at`)},
    'revision', ${alias}.revision)`;
}

type Tables = {
  readonly users: string;
  readonly groups: string;
  readonly members: string;
};

function membersOfGroup(tables: Tables, alias: string): string {
  return `coalesce((select jsonb_agg(m.user_id order by m.position) from ${tables.members} m
    where m.tenant = ${alias}.tenant and m.group_id = ${alias}.id), '[]'::jsonb)`;
}

type Stored<T> = { readonly resource: T; readonly revision: number };

function parsed(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function appData(value: unknown): AppData | undefined {
  // SAFETY: the column holds what this store wrote from `DirectoryUser.x` / `DirectoryGroup.x`, a plain JSON object.
  return isRecord(value) ? (value as AppData) : undefined;
}

function storedUser(value: unknown): Stored<DirectoryUser> {
  const row = parsed(value);
  if (!isRecord(row)) {
    throw new Error("PermDock: postgresDirectoryStore read a malformed user");
  }
  return {
    revision: Number(row["revision"]),
    resource: compact<DirectoryUser>({
      id: String(row["id"]),
      userName: String(row["userName"]),
      externalId: text(row["externalId"]),
      active: row["active"] === true,
      emails: emailsOf(row["emails"]),
      x: appData(row["x"]),
      meta: {
        created: String(row["created"]),
        lastModified: String(row["lastModified"]),
        resourceType: "User",
      },
    }),
  };
}

function storedGroup(value: unknown): Stored<DirectoryGroup> {
  const row = parsed(value);
  if (!isRecord(row)) {
    throw new Error("PermDock: postgresDirectoryStore read a malformed group");
  }
  const members = Array.isArray(row["members"]) ? row["members"] : [];
  const roles = row["roles"];
  return {
    revision: Number(row["revision"]),
    resource: compact<DirectoryGroup>({
      id: String(row["id"]),
      displayName: String(row["displayName"]),
      externalId: text(row["externalId"]),
      members: members.flatMap((member: unknown) =>
        typeof member === "string" ? [{ value: member }] : [],
      ),
      roles: Array.isArray(roles)
        ? roles.filter((role): role is string => typeof role === "string")
        : undefined,
      x: appData(row["x"]),
      meta: {
        created: String(row["created"]),
        lastModified: String(row["lastModified"]),
        resourceType: "Group",
      },
    }),
  };
}

/** A stored or IdP-sent `meta.created` the database can read; anything else is "now". */
function createdParam(created: string): string | null {
  return created !== "" && !Number.isNaN(Date.parse(created)) ? created : null;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${prefix}${hex}`;
}

/** Each value once, first occurrence first: one member row per user. */
function uniqueMembers(group: DirectoryGroup): string[] {
  return [...new Set(group.members.map((member) => member.value))];
}

function constraintOf(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  for (const key of ["constraint", "constraint_name", "detail", "message"]) {
    const value = error[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return "";
}

/** A unique violation (`23505`) as `DirectoryUniquenessError`; any other error is rethrown. */
function uniqueness(error: unknown, kind: "user" | "group"): never {
  if (isRecord(error) && error["code"] === "23505") {
    const constraint = constraintOf(error);
    throw new DirectoryUniquenessError(
      kind === "user" &&
        (constraint.includes(SCIM_UNIQUE.userName) ||
          constraint.includes("user_name"))
        ? "userName"
        : "externalId",
    );
  }
  throw error;
}

type Kind = "user" | "group";

const COLUMNS: Record<Kind, Readonly<Record<string, string>>> = {
  user: {
    id: "u.id",
    userName: "u.user_name",
    externalId: "u.external_id",
    active: "u.active::text",
  },
  group: {
    id: "g.id",
    displayName: "g.display_name",
    externalId: "g.external_id",
  },
};

function asText(value: string | boolean): string {
  return typeof value === "boolean" ? String(value) : value;
}

/**
 * The SQL twin of `matchFilter`: a missing attribute matches only `ne`, and
 * booleans compare case-insensitively and only with `eq` / `ne`.
 */
function compare(
  column: string,
  op: "eq" | "ne" | "co" | "sw",
  value: string | boolean,
  bind: (value: unknown) => string,
  caseless: boolean,
): string {
  if (caseless && (op === "co" || op === "sw")) {
    return "false";
  }
  const left = caseless ? `lower(${column})` : column;
  const right = bind(caseless ? asText(value).toLowerCase() : value);
  switch (op) {
    case "eq":
      return `${left} = ${right}`;
    case "ne":
      return `${left} is distinct from ${right}`;
    case "co":
      return `strpos(${left}, ${right}) > 0`;
    case "sw":
      return `starts_with(${left}, ${right})`;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function compileFilter(
  filter: ScimFilter,
  kind: Kind,
  tables: Tables,
  bind: (value: unknown) => string,
): string {
  switch (filter.op) {
    case "and":
    case "or":
      return `(${filter.filters
        .map((item) => compileFilter(item, kind, tables, bind))
        .join(` ${filter.op} `)})`;
    case "pr":
    case "eq":
    case "ne":
    case "co":
    case "sw": {
      if (filter.attribute === "members.value") {
        if (kind !== "group") {
          return filter.op === "ne" ? "true" : "false";
        }
        const member =
          filter.op === "pr"
            ? "true"
            : compare("m.user_id", filter.op, filter.value, bind, false);
        return `exists (select 1 from ${tables.members} m where m.tenant = g.tenant and m.group_id = g.id and ${member})`;
      }
      const column = COLUMNS[kind][filter.attribute];
      if (column === undefined) {
        return filter.op === "ne" ? "true" : "false";
      }
      if (filter.op === "pr") {
        return `coalesce(${column}, '') <> ''`;
      }
      const caseless =
        typeof filter.value === "boolean" || filter.attribute === "active";
      return compare(column, filter.op, filter.value, bind, caseless);
    }
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

function where(
  tenant: string,
  filter: ScimFilter | undefined,
  kind: Kind,
  tables: Tables,
): { readonly sql: string; readonly params: unknown[] } {
  const params: unknown[] = [tenant];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${String(params.length)}`;
  };
  const alias = kind === "group" ? "g" : "u";
  const clause =
    filter === undefined ? "true" : compileFilter(filter, kind, tables, bind);
  return { sql: `${alias}.tenant = $1 and ${clause}`, params };
}

function window(page: ScimPage): {
  readonly offset: number;
  readonly count: number;
} {
  const count = Math.max(0, Math.trunc(page.count ?? DEFAULT_COUNT));
  if (page.cursor !== undefined && page.cursor !== "") {
    const decoded = Math.trunc(Number(page.cursor));
    return {
      offset: Number.isFinite(decoded) && decoded > 0 ? decoded : 0,
      count,
    };
  }
  return {
    offset:
      page.startIndex !== undefined && page.startIndex > 0
        ? Math.trunc(page.startIndex) - 1
        : 0,
    count,
  };
}

function pageResult<T>(
  items: readonly T[],
  total: number,
  offset: number,
): ScimPageResult<T> {
  const next = offset + items.length;
  return compact<ScimPageResult<T>>({
    Resources: items,
    totalResults: total,
    startIndex: offset + 1,
    itemsPerPage: items.length,
    nextCursor: next < total ? String(next) : undefined,
  });
}

function userParams(
  tenant: string,
  user: DirectoryUser,
  createdOrRevision: unknown,
  now: string,
): unknown[] {
  return [
    tenant,
    user.id,
    user.userName,
    user.externalId ?? null,
    user.active,
    json(user.emails),
    json(user.x),
    createdOrRevision,
    now,
  ];
}

function groupParams(
  tenant: string,
  group: DirectoryGroup,
  createdOrRevision: unknown,
  now: string,
): unknown[] {
  return [
    tenant,
    group.id,
    group.displayName,
    group.externalId ?? null,
    group.roles === undefined ? null : [...group.roles],
    json(group.x),
    createdOrRevision,
    now,
    uniqueMembers(group),
  ];
}

type Statements = Readonly<
  Record<
    | "getUser"
    | "getGroup"
    | "upsertUser"
    | "updateUser"
    | "upsertGroup"
    | "updateGroup"
    | "deleteUser"
    | "deleteGroup"
    | "groupsFor",
    string
  >
>;

/** Reads the row, applies the operations and writes only if no other write landed in between; `write` answers `null` then. */
async function patch<T>(
  read: () => Promise<Stored<T> | null>,
  ops: readonly ScimPatchOp[],
  step: (value: T, op: ScimPatchOp) => T,
  write: (next: T, revision: number) => Promise<T | null>,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt re-reads the row the previous write lost to
    const current = await read();
    if (current === null) {
      throw new DirectoryNotFoundError();
    }
    let next = current.resource;
    for (const op of ops) {
      next = step(next, op);
    }
    // oxlint-disable-next-line no-await-in-loop -- the write is conditional on the revision just read
    const written = await write(next, current.revision);
    if (written !== null) {
      return written;
    }
  }
  throw new Error(
    `PermDock: postgresDirectoryStore: ${label} kept changing during a PATCH`,
  );
}

function statements(tables: Tables): Statements {
  const upsertUser = `insert into ${tables.users} as u
    (tenant, id, user_name, external_id, active, emails, x, created_at, updated_at)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, coalesce($8::timestamptz, $9::timestamptz), $9::timestamptz)
    on conflict (tenant, id) do update set
      user_name = excluded.user_name, external_id = excluded.external_id, active = excluded.active,
      emails = excluded.emails, x = excluded.x, updated_at = excluded.updated_at, revision = u.revision + 1
    returning ${userJson("u")} as resource`;
  const updateUser = `update ${tables.users} as u set
      user_name = $3, external_id = $4, active = $5, emails = $6::jsonb, x = $7::jsonb,
      updated_at = $9::timestamptz, revision = u.revision + 1
    where u.tenant = $1 and u.id = $2 and u.revision = $8
    returning ${userJson("u")} as resource`;
  // The members CTEs touch disjoint rows: `dropped` only those outside $9, `kept` only those in it.
  const members = `dropped as (
      delete from ${tables.members} m using g
      where m.tenant = g.tenant and m.group_id = g.id and not (m.user_id = any($9::text[]))
    ),
    kept as (
      insert into ${tables.members} (tenant, group_id, user_id, position)
      select g.tenant, g.id, v.user_id, v.position::integer
      from g cross join unnest($9::text[]) with ordinality as v(user_id, position)
      on conflict (tenant, group_id, user_id) do update set position = excluded.position
    )
    select ${groupJson("g", "to_jsonb($9::text[])")} as resource from g`;
  const upsertGroup = `with g as (
      insert into ${tables.groups} as t
        (tenant, id, display_name, external_id, roles, x, created_at, updated_at)
      values ($1, $2, $3, $4, $5::text[], $6::jsonb, coalesce($7::timestamptz, $8::timestamptz), $8::timestamptz)
      on conflict (tenant, id) do update set
        display_name = excluded.display_name, external_id = excluded.external_id, roles = excluded.roles,
        x = excluded.x, updated_at = excluded.updated_at, revision = t.revision + 1
      returning t.*
    ),
    ${members}`;
  const updateGroup = `with g as (
      update ${tables.groups} as t set
        display_name = $3, external_id = $4, roles = $5::text[], x = $6::jsonb,
        updated_at = $8::timestamptz, revision = t.revision + 1
      where t.tenant = $1 and t.id = $2 and t.revision = $7
      returning t.*
    ),
    ${members}`;
  return {
    getUser: `select ${userJson("u")} as resource from ${tables.users} u where u.tenant = $1 and u.id = $2`,
    getGroup: `select ${groupJson("g", membersOfGroup(tables, "g"))} as resource
      from ${tables.groups} g where g.tenant = $1 and g.id = $2`,
    upsertUser,
    updateUser,
    upsertGroup,
    updateGroup,
    deleteUser: `with d as (
        delete from ${tables.users} where tenant = $1 and id = $2 returning tenant, id
      ),
      m as (
        delete from ${tables.members} mm using d
        where mm.tenant = d.tenant and mm.user_id = d.id returning mm.group_id
      ),
      touched as (
        update ${tables.groups} t set updated_at = $3::timestamptz, revision = t.revision + 1
        where t.tenant = $1 and t.id in (select group_id from m)
      )
      select count(*)::integer as deleted from d`,
    deleteGroup: `delete from ${tables.groups} where tenant = $1 and id = $2 returning id`,
    groupsFor: `select ${groupJson("g", membersOfGroup(tables, "g"))} as resource
      from ${tables.groups} g
      where g.tenant = $1 and exists (
        select 1 from ${tables.members} m where m.tenant = g.tenant and m.group_id = g.id and m.user_id = $2
      )
      order by g.seq`,
  };
}

function findSql(
  kind: Kind,
  tables: Tables,
  clause: string,
  page: { readonly offset: number; readonly count: number },
): string {
  const table = kind === "user" ? tables.users : tables.groups;
  const alias = kind === "user" ? "u" : "g";
  const resource =
    kind === "user"
      ? userJson(alias)
      : groupJson(alias, membersOfGroup(tables, alias));
  return `with matched as (
      select ${alias}.seq from ${table} ${alias} where ${clause}
    ),
    paged as (
      select seq from matched order by seq offset ${String(page.offset)} limit ${String(page.count)}
    )
    select (select count(*)::integer from matched) as total,
      coalesce((
        select jsonb_agg(${resource} order by ${alias}.seq)
        from ${table} ${alias} join paged p on p.seq = ${alias}.seq
      ), '[]'::jsonb) as resources`;
}

/**
 * A `DirectoryStore` over the tables `permdock scim generate` writes, called
 * through a `SqlQuery` that may read and write them (the table owner, or a
 * role granted on them). Every method is one statement, so a pool needs no
 * transaction: a group and its members change together, and a PATCH that
 * races another write re-reads the row and applies its operations again.
 */
export function postgresDirectoryStore(
  query: SqlQuery,
  options: PostgresDirectoryStoreOptions = {},
): DirectoryStore {
  const schema = quoteSqlIdent(options.schema ?? SCIM_SCHEMA);
  const tables: Tables = {
    users: `${schema}.${quoteSqlIdent(SCIM_TABLES.users)}`,
    groups: `${schema}.${quoteSqlIdent(SCIM_TABLES.groups)}`,
    members: `${schema}.${quoteSqlIdent(SCIM_TABLES.members)}`,
  };
  const sql = statements(tables);
  const rows = async (
    statement: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> =>
    sqlRows(await query(statement, values));

  async function readUser(
    tenant: string,
    id: string,
  ): Promise<Stored<DirectoryUser> | null> {
    const [row] = await rows(sql.getUser, [tenant, id]);
    return row === undefined ? null : storedUser(row["resource"]);
  }

  async function readGroup(
    tenant: string,
    id: string,
  ): Promise<Stored<DirectoryGroup> | null> {
    const [row] = await rows(sql.getGroup, [tenant, id]);
    return row === undefined ? null : storedGroup(row["resource"]);
  }

  async function find<T>(
    kind: Kind,
    tenant: string,
    filter: ScimFilter | undefined,
    page: ScimPage,
    read: (value: unknown) => Stored<T>,
  ): Promise<ScimPageResult<T>> {
    const paging = window(page);
    const clause = where(tenant, filter, kind, tables);
    const [row] = await rows(
      findSql(kind, tables, clause.sql, paging),
      clause.params,
    );
    const resources = parsed(row?.["resources"]);
    const items = Array.isArray(resources)
      ? resources.map((item: unknown) => read(item).resource)
      : [];
    return pageResult(items, Number(row?.["total"] ?? 0), paging.offset);
  }

  return {
    name: "postgres",
    async getUser(tenant, id) {
      return (await readUser(tenant, id))?.resource ?? null;
    },
    findUsers(tenant, filter, page) {
      return find("user", tenant, filter, page, storedUser);
    },
    async putUser(tenant, user) {
      const id = user.id === "" ? randomId("u_") : user.id;
      try {
        const [row] = await rows(
          sql.upsertUser,
          userParams(
            tenant,
            { ...user, id },
            createdParam(user.meta.created),
            isoNow(),
          ),
        );
        return storedUser(row?.["resource"]).resource;
      } catch (error) {
        return uniqueness(error, "user");
      }
    },
    patchUser(tenant, id, ops) {
      return patch(
        () => readUser(tenant, id),
        ops,
        applyUserOp,
        async (next, revision) => {
          try {
            const [row] = await rows(
              sql.updateUser,
              userParams(tenant, { ...next, id }, revision, isoNow()),
            );
            return row === undefined
              ? null
              : storedUser(row["resource"]).resource;
          } catch (error) {
            return uniqueness(error, "user");
          }
        },
        `user ${id}`,
      );
    },
    async deleteUser(tenant, id) {
      const [row] = await rows(sql.deleteUser, [tenant, id, isoNow()]);
      if (Number(row?.["deleted"] ?? 0) === 0) {
        throw new DirectoryNotFoundError();
      }
    },
    async getGroup(tenant, id) {
      return (await readGroup(tenant, id))?.resource ?? null;
    },
    findGroups(tenant, filter, page) {
      return find("group", tenant, filter, page, storedGroup);
    },
    async putGroup(tenant, group) {
      const id = group.id === "" ? randomId("g_") : group.id;
      try {
        const [row] = await rows(
          sql.upsertGroup,
          groupParams(
            tenant,
            { ...group, id },
            createdParam(group.meta.created),
            isoNow(),
          ),
        );
        return storedGroup(row?.["resource"]).resource;
      } catch (error) {
        return uniqueness(error, "group");
      }
    },
    patchGroup(tenant, id, ops) {
      return patch(
        () => readGroup(tenant, id),
        ops,
        applyGroupOp,
        async (next, revision) => {
          try {
            const [row] = await rows(
              sql.updateGroup,
              groupParams(tenant, { ...next, id }, revision, isoNow()),
            );
            return row === undefined
              ? null
              : storedGroup(row["resource"]).resource;
          } catch (error) {
            return uniqueness(error, "group");
          }
        },
        `group ${id}`,
      );
    },
    async deleteGroup(tenant, id) {
      const found = await rows(sql.deleteGroup, [tenant, id]);
      if (found.length === 0) {
        throw new DirectoryNotFoundError();
      }
    },
    async groupsFor(tenant, userId) {
      const found = await rows(sql.groupsFor, [tenant, userId]);
      return found.map((row) => storedGroup(row["resource"]).resource);
    },
  };
}
