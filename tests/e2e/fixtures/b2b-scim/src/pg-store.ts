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
} from 'permdock/scim';

type Emails = NonNullable<DirectoryUser['emails']>;

type Rows<T> = Promise<{ readonly rows: T[] }>;

export type SqlQuery = {
  query<T>(text: string, params?: unknown[]): Rows<T>;
};

/** PGlite satisfies this directly; a `pg` pool needs a small adapter. */
export type SqlClient = SqlQuery & {
  exec(text: string): Promise<unknown>;
  transaction<R>(run: (tx: SqlQuery) => Promise<R>): Promise<R>;
};

type UserRow = {
  id: string;
  userName: string;
  externalId: string | null;
  active: boolean;
  emails: Emails | null;
  location: string | null;
  created: string;
  lastModified: string;
};

type GroupRow = {
  id: string;
  displayName: string;
  externalId: string | null;
  roles: string[] | null;
  location: string | null;
  created: string;
  lastModified: string;
  members: string[];
};

const DEFAULT_COUNT = 100;

export const directorySchema = `
  create table if not exists scim_user (
    seq bigserial unique,
    tenant text not null,
    id text not null,
    "userName" text not null,
    "externalId" text,
    active boolean not null,
    emails jsonb,
    location text,
    created text not null,
    "lastModified" text not null,
    primary key (tenant, id),
    constraint "scim_user_userName" unique (tenant, "userName"),
    constraint "scim_user_externalId" unique (tenant, "externalId")
  );
  create table if not exists scim_group (
    seq bigserial unique,
    tenant text not null,
    id text not null,
    "displayName" text not null,
    "externalId" text,
    roles jsonb,
    location text,
    created text not null,
    "lastModified" text not null,
    primary key (tenant, id),
    constraint "scim_group_externalId" unique (tenant, "externalId")
  );
  create table if not exists scim_member (
    seq bigserial,
    tenant text not null,
    group_id text not null,
    user_id text not null,
    primary key (tenant, group_id, user_id),
    foreign key (tenant, group_id) references scim_group (tenant, id) on delete cascade
  );
`;

const USER_COLUMNS = `id, "userName", "externalId", active, emails, location, created, "lastModified"`;
const GROUP_COLUMNS = `g.id, g."displayName", g."externalId", g.roles, g.location, g.created, g."lastModified",
  coalesce((select array_agg(m.user_id order by m.seq) from scim_member m
    where m.tenant = g.tenant and m.group_id = g.id), '{}') as members`;

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function toUser(row: UserRow): DirectoryUser {
  return {
    id: row.id,
    userName: row.userName,
    active: row.active,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    ...(row.emails === null ? {} : { emails: row.emails }),
    meta: {
      created: row.created,
      lastModified: row.lastModified,
      resourceType: 'User',
      ...(row.location === null ? {} : { location: row.location }),
    },
  };
}

function toGroup(row: GroupRow): DirectoryGroup {
  return {
    id: row.id,
    displayName: row.displayName,
    members: row.members.map((value) => ({ value })),
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    ...(row.roles === null ? {} : { roles: row.roles }),
    meta: {
      created: row.created,
      lastModified: row.lastModified,
      resourceType: 'Group',
      ...(row.location === null ? {} : { location: row.location }),
    },
  };
}

/** Maps a unique violation to the SCIM `uniqueness` error. */
function uniqueness(error: unknown): never {
  const pg = error as { code?: unknown; constraint?: unknown };
  if (pg.code === '23505') {
    const constraint = typeof pg.constraint === 'string' ? pg.constraint : '';
    throw new DirectoryUniquenessError(
      constraint.endsWith('userName') ? 'userName' : 'externalId',
    );
  }
  throw error;
}

type Kind = 'user' | 'group';

const COLUMNS: Record<Kind, Readonly<Record<string, string>>> = {
  user: {
    id: 'id',
    userName: '"userName"',
    externalId: '"externalId"',
    active: 'active::text',
  },
  group: {
    id: 'g.id',
    displayName: 'g."displayName"',
    externalId: 'g."externalId"',
  },
};

function asText(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : value;
}

/**
 * The SQL twin of the in-memory matcher: a missing attribute matches only
 * `ne`, booleans compare case-insensitively and only with `eq` / `ne`.
 */
function compare(
  column: string,
  op: 'eq' | 'ne' | 'co' | 'sw',
  value: string | boolean,
  bind: (value: unknown) => string,
  caseless: boolean,
): string {
  if (caseless && (op === 'co' || op === 'sw')) {
    return 'false';
  }
  const left = caseless ? `lower(${column})` : column;
  const right = bind(caseless ? asText(value).toLowerCase() : value);
  switch (op) {
    case 'eq':
      return `${left} = ${right}`;
    case 'ne':
      return `${left} is distinct from ${right}`;
    case 'co':
      return `strpos(${left}, ${right}) > 0`;
    case 'sw':
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
  bind: (value: unknown) => string,
): string {
  switch (filter.op) {
    case 'and':
    case 'or':
      return `(${filter.filters
        .map((item) => compileFilter(item, kind, bind))
        .join(` ${filter.op} `)})`;
    case 'pr':
    case 'eq':
    case 'ne':
    case 'co':
    case 'sw': {
      if (filter.attribute === 'members.value') {
        if (kind !== 'group') {
          return filter.op === 'ne' ? 'true' : 'false';
        }
        const member =
          filter.op === 'pr'
            ? 'true'
            : compare('m.user_id', filter.op, filter.value, bind, false);
        return `exists (select 1 from scim_member m where m.tenant = g.tenant and m.group_id = g.id and ${member})`;
      }
      const column = COLUMNS[kind][filter.attribute];
      if (column === undefined) {
        return filter.op === 'ne' ? 'true' : 'false';
      }
      if (filter.op === 'pr') {
        return `coalesce(${column}, '') <> ''`;
      }
      const caseless =
        typeof filter.value === 'boolean' || filter.attribute === 'active';
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
): { readonly sql: string; readonly params: unknown[] } {
  const params: unknown[] = [tenant];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${String(params.length)}`;
  };
  const prefix = kind === 'group' ? 'g.' : '';
  const clause =
    filter === undefined ? 'true' : compileFilter(filter, kind, bind);
  return { sql: `${prefix}tenant = $1 and ${clause}`, params };
}

function window(page: ScimPage): {
  readonly offset: number;
  readonly count: number;
} {
  const count = page.count ?? DEFAULT_COUNT;
  if (page.cursor !== undefined && page.cursor !== '') {
    const decoded = Math.trunc(Number(page.cursor));
    return {
      offset: Number.isFinite(decoded) && decoded > 0 ? decoded : 0,
      count,
    };
  }
  return {
    offset:
      page.startIndex !== undefined && page.startIndex > 0
        ? page.startIndex - 1
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
  return {
    Resources: items,
    totalResults: total,
    startIndex: offset + 1,
    itemsPerPage: items.length,
    ...(next < total ? { nextCursor: String(next) } : {}),
  };
}

function without<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function emailsOf(value: unknown): Emails {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const email = item as {
          value?: unknown;
          primary?: unknown;
          type?: unknown;
        } | null;
        return typeof email?.value === 'string'
          ? [
              {
                value: email.value,
                ...(typeof email.primary === 'boolean'
                  ? { primary: email.primary }
                  : {}),
                ...(typeof email.type === 'string' ? { type: email.type } : {}),
              },
            ]
          : [];
      })
    : [];
}

function applyUserOp(user: DirectoryUser, op: ScimPatchOp): DirectoryUser {
  switch (op.path ?? '') {
    case 'active':
      return typeof op.value === 'boolean'
        ? { ...user, active: op.value }
        : user;
    case 'userName':
      return typeof op.value === 'string'
        ? { ...user, userName: op.value }
        : user;
    case 'externalId':
      return typeof op.value === 'string'
        ? { ...user, externalId: op.value }
        : without(user, 'externalId');
    case 'emails':
      return Array.isArray(op.value)
        ? { ...user, emails: emailsOf(op.value) }
        : without(user, 'emails');
    default:
      return user;
  }
}

function memberValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const member = item as { value?: unknown } | null;
        return typeof member?.value === 'string' ? [member.value] : [];
      })
    : [];
}

function applyGroupOp(group: DirectoryGroup, op: ScimPatchOp): DirectoryGroup {
  const path = op.path ?? '';
  if (path === 'displayName') {
    return typeof op.value === 'string'
      ? { ...group, displayName: op.value }
      : group;
  }
  if (path === 'externalId') {
    return typeof op.value === 'string'
      ? { ...group, externalId: op.value }
      : without(group, 'externalId');
  }
  if (path === 'roles') {
    return Array.isArray(op.value)
      ? {
          ...group,
          roles: op.value.filter(
            (item: unknown): item is string => typeof item === 'string',
          ),
        }
      : without(group, 'roles');
  }
  if (path !== 'members') {
    return group;
  }
  const incoming = memberValues(op.value);
  const current = group.members.map((member) => member.value);
  const next =
    op.op === 'replace'
      ? incoming
      : op.op === 'add'
        ? [...current, ...incoming.filter((value) => !current.includes(value))]
        : current.filter((value) => !incoming.includes(value));
  return { ...group, members: next.map((value) => ({ value })) };
}

async function readUser(
  sql: SqlQuery,
  tenant: string,
  id: string,
  lock = false,
) {
  const { rows } = await sql.query<UserRow>(
    `select ${USER_COLUMNS} from scim_user where tenant = $1 and id = $2${lock ? ' for update' : ''}`,
    [tenant, id],
  );
  return rows[0] === undefined ? null : toUser(rows[0]);
}

async function readGroup(sql: SqlQuery, tenant: string, id: string) {
  const { rows } = await sql.query<GroupRow>(
    `select ${GROUP_COLUMNS} from scim_group g where g.tenant = $1 and g.id = $2`,
    [tenant, id],
  );
  return rows[0] === undefined ? null : toGroup(rows[0]);
}

async function writeUser(
  sql: SqlQuery,
  tenant: string,
  user: DirectoryUser,
): Promise<DirectoryUser> {
  const at = new Date().toISOString();
  const { rows } = await sql
    .query<UserRow>(
      `insert into scim_user (tenant, id, "userName", "externalId", active, emails, location, created, "lastModified")
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       on conflict (tenant, id) do update set
         "userName" = excluded."userName", "externalId" = excluded."externalId",
         active = excluded.active, emails = excluded.emails,
         location = excluded.location, "lastModified" = excluded."lastModified"
       returning ${USER_COLUMNS}`,
      [
        tenant,
        user.id,
        user.userName,
        user.externalId ?? null,
        user.active,
        user.emails === undefined ? null : JSON.stringify(user.emails),
        user.meta.location ?? null,
        at,
      ],
    )
    .catch(uniqueness);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('scim_user upsert returned no row');
  }
  return toUser(row);
}

async function writeGroup(
  sql: SqlQuery,
  tenant: string,
  group: DirectoryGroup,
): Promise<DirectoryGroup> {
  const at = new Date().toISOString();
  await sql
    .query(
      `insert into scim_group (tenant, id, "displayName", "externalId", roles, location, created, "lastModified")
       values ($1, $2, $3, $4, $5, $6, $7, $7)
       on conflict (tenant, id) do update set
         "displayName" = excluded."displayName", "externalId" = excluded."externalId",
         roles = excluded.roles, location = excluded.location,
         "lastModified" = excluded."lastModified"`,
      [
        tenant,
        group.id,
        group.displayName,
        group.externalId ?? null,
        group.roles === undefined ? null : JSON.stringify(group.roles),
        group.meta.location ?? null,
        at,
      ],
    )
    .catch(uniqueness);
  await sql.query(
    'delete from scim_member where tenant = $1 and group_id = $2',
    [tenant, group.id],
  );
  for (const value of new Set(group.members.map((member) => member.value))) {
    // oxlint-disable-next-line no-await-in-loop -- members keep their order
    await sql.query(
      'insert into scim_member (tenant, group_id, user_id) values ($1, $2, $3)',
      [tenant, group.id, value],
    );
  }
  const written = await readGroup(sql, tenant, group.id);
  if (written === null) {
    throw new Error('scim_group upsert returned no row');
  }
  return written;
}

/** A `DirectoryStore` on Postgres; call `ready` once before serving. */
export function pgDirectoryStore(sql: SqlClient): DirectoryStore & {
  readonly ready: () => Promise<void>;
} {
  return {
    async ready() {
      await sql.exec(directorySchema);
    },
    getUser: (tenant, id) => readUser(sql, tenant, id),
    async findUsers(tenant, filter, page) {
      const { offset, count } = window(page);
      const clause = where(tenant, filter, 'user');
      const [{ rows }, total] = await Promise.all([
        sql.query<UserRow>(
          `select ${USER_COLUMNS} from scim_user where ${clause.sql} order by seq offset ${String(offset)} limit ${String(count)}`,
          clause.params,
        ),
        sql.query<{ total: number }>(
          `select count(*)::int as total from scim_user where ${clause.sql}`,
          clause.params,
        ),
      ]);
      return pageResult(rows.map(toUser), total.rows[0]?.total ?? 0, offset);
    },
    putUser(tenant, user) {
      return writeUser(sql, tenant, {
        ...user,
        id: user.id === '' ? randomId('u_') : user.id,
      });
    },
    patchUser(tenant, id, ops) {
      return sql.transaction(async (tx) => {
        const existing = await readUser(tx, tenant, id, true);
        if (existing === null) {
          throw new DirectoryNotFoundError();
        }
        let next = existing;
        for (const op of ops) {
          next = applyUserOp(next, op);
        }
        return writeUser(tx, tenant, next);
      });
    },
    deleteUser(tenant, id) {
      return sql.transaction(async (tx) => {
        const { rows } = await tx.query(
          'delete from scim_user where tenant = $1 and id = $2 returning id',
          [tenant, id],
        );
        if (rows.length === 0) {
          throw new DirectoryNotFoundError();
        }
        await tx.query(
          `update scim_group g set "lastModified" = $3
           from scim_member m
           where m.tenant = $1 and m.user_id = $2 and g.tenant = m.tenant and g.id = m.group_id`,
          [tenant, id, new Date().toISOString()],
        );
        await tx.query(
          'delete from scim_member where tenant = $1 and user_id = $2',
          [tenant, id],
        );
      });
    },
    getGroup: (tenant, id) => readGroup(sql, tenant, id),
    async findGroups(tenant, filter, page) {
      const { offset, count } = window(page);
      const clause = where(tenant, filter, 'group');
      const [{ rows }, total] = await Promise.all([
        sql.query<GroupRow>(
          `select ${GROUP_COLUMNS} from scim_group g where ${clause.sql} order by g.seq offset ${String(offset)} limit ${String(count)}`,
          clause.params,
        ),
        sql.query<{ total: number }>(
          `select count(*)::int as total from scim_group g where ${clause.sql}`,
          clause.params,
        ),
      ]);
      return pageResult(rows.map(toGroup), total.rows[0]?.total ?? 0, offset);
    },
    putGroup(tenant, group) {
      return sql.transaction((tx) =>
        writeGroup(tx, tenant, {
          ...group,
          id: group.id === '' ? randomId('g_') : group.id,
        }),
      );
    },
    patchGroup(tenant, id, ops) {
      return sql.transaction(async (tx) => {
        await tx.query(
          'select 1 from scim_group where tenant = $1 and id = $2 for update',
          [tenant, id],
        );
        const existing = await readGroup(tx, tenant, id);
        if (existing === null) {
          throw new DirectoryNotFoundError();
        }
        let next = existing;
        for (const op of ops) {
          next = applyGroupOp(next, op);
        }
        return writeGroup(tx, tenant, next);
      });
    },
    async deleteGroup(tenant, id) {
      const { rows } = await sql.query(
        'delete from scim_group where tenant = $1 and id = $2 returning id',
        [tenant, id],
      );
      if (rows.length === 0) {
        throw new DirectoryNotFoundError();
      }
    },
    async groupsFor(tenant, userId) {
      const { rows } = await sql.query<GroupRow>(
        `select ${GROUP_COLUMNS} from scim_group g
         where g.tenant = $1 and exists (
           select 1 from scim_member m where m.tenant = g.tenant and m.group_id = g.id and m.user_id = $2
         ) order by g.seq`,
        [tenant, userId],
      );
      return rows.map(toGroup);
    },
  };
}
