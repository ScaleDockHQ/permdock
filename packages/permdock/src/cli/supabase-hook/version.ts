import type { RoleKeys } from "../../supabase/roles.ts";
import type { Parts } from "./parts.ts";

import { AUTHZ_VERSION_TABLE } from "../../supabase/sources.ts";
import { tableKey } from "../sql/deciding-columns.ts";
import { quoteIdent, quoteLiteral, quoteQualified } from "../sql/quote.ts";

const VERSION_TRIGGER = "permdock_authz_version";

export const AUTHZ_VERSION_BUMP = "permdock_bump_authz_version_for";

export function versionSql(parts: Parts): string {
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
      ]) => `drop trigger if exists ${quoteIdent(VERSION_TRIGGER)} on ${quoteQualified(name)};
create trigger ${quoteIdent(VERSION_TRIGGER)}
  after insert or update or delete on ${quoteQualified(name)}
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
${indent}  select u.${quoteIdent(users.key)}::uuid from ${quoteQualified(users.table)} u
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
      const target = quoteQualified(group.table);
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
      const target = quoteQualified(entry.table);
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
        ? `select h.${quoteIdent(holder.user)}::uuid as user_id from ${quoteQualified(holder.table)} h where h.${quoteIdent(holder.through.ref)} = old.${quoteIdent(holder.through.id)}`
        : `select u.${quoteIdent(holder.userThrough.key)}::uuid as user_id from ${quoteQualified(holder.table)} h join ${quoteQualified(holder.userThrough.table)} u on u.${quoteIdent(holder.userThrough.id)} = h.${quoteIdent(holder.user)} where h.${quoteIdent(holder.through.ref)} = old.${quoteIdent(holder.through.id)}`,
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
      const target = quoteQualified(group.table);
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
