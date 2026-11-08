import type { RowTier } from "./tiers.ts";

import { KIND, ROW_TIERS, TENANTS, uuidOf, uuidSql } from "./tiers.ts";

/**
 * Seed for `./project`: tenant rows, a folder tree with edges, documents that
 * follow a folder, a thread and message chain, a manager chain, Storage objects
 * and approval requests. The caller `SCALE_CALLER` belongs to `CALLER_TENANTS`
 * tenants as `member`.
 */
export const SCALE_CALLER = uuidOf(KIND.user, 5_000_000);
export const CALLER_TENANTS = 12;
const FOLDER_DEPTH = 8;

const tenant = (n: string): string => uuidSql(KIND.tenant, n);

export const SCALE_TABLES = `
create schema storage;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid
);
create function storage.foldername(name text) returns text[]
  language sql immutable as $$
  select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1]
$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, anon;
grant select, insert, update, delete on storage.objects to authenticated;
grant execute on function storage.foldername(text) to authenticated, anon;

create table public.organization_members (
  organization_id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.item (id uuid primary key, "orgId" uuid not null, "ownerId" uuid not null);
create table public.thread (id uuid primary key, "orgId" uuid not null);
create table public.message (
  id uuid primary key,
  "orgId" uuid not null,
  "threadId" uuid not null references public.thread (id)
);
create table public.folder (
  id uuid primary key,
  "parentId" uuid references public.folder (id),
  restricted boolean not null default false,
  "ownerId" uuid
);
create table public.doc (
  id uuid primary key,
  "folderId" uuid not null references public.folder (id),
  "ownerId" uuid,
  restricted boolean not null default false
);
create table public.folder_viewers (
  folder_id uuid not null references public.folder (id) on delete cascade,
  user_id uuid not null,
  expires_at timestamptz
);
create table public.folder_editors (
  folder_id uuid not null references public.folder (id) on delete cascade,
  user_id uuid not null
);
create table public.employee (
  id uuid primary key,
  "orgId" uuid not null,
  "userId" uuid not null,
  "managerId" uuid references public.employee (id)
);
`;

/**
 * Folders are a forest of chains `FOLDER_DEPTH` deep; one in ten rows is a
 * folder.
 */
export function scaleSeed(tier: RowTier): string {
  const rows = ROW_TIERS[tier];
  const folders = Math.max(Math.floor(rows / 10), FOLDER_DEPTH);
  const employees = Math.max(Math.floor(rows / 10), FOLDER_DEPTH);
  return `
insert into auth.users (id) values ('${SCALE_CALLER}');
insert into public.organization_members (organization_id, user_id, role)
  select ${tenant("t")}, '${SCALE_CALLER}', 'member' from generate_series(0, ${CALLER_TENANTS - 1}) t;
insert into public.item (id, "orgId", "ownerId")
  select ${uuidSql(KIND.item, "n")}, ${tenant(`n % ${TENANTS}`)}, '${SCALE_CALLER}'
  from generate_series(0, ${rows - 1}) n;
insert into public.thread (id, "orgId")
  select ${uuidSql(KIND.thread, "n")}, ${tenant(`n % ${TENANTS}`)}
  from generate_series(0, ${Math.max(Math.floor(rows / 10), 1) - 1}) n;
insert into public.message (id, "orgId", "threadId")
  select ${uuidSql(KIND.message, "n")}, ${tenant(`(n % ${Math.max(Math.floor(rows / 10), 1)}) % ${TENANTS}`)},
         ${uuidSql(KIND.thread, `n % ${Math.max(Math.floor(rows / 10), 1)}`)}
  from generate_series(0, ${rows - 1}) n;
insert into public.folder (id, "parentId", restricted, "ownerId")
  select ${uuidSql(KIND.folder, "n")},
         case when n % ${FOLDER_DEPTH} = 0 then null else ${uuidSql(KIND.folder, "n - 1")} end,
         false, null
  from generate_series(0, ${folders - 1}) n;
insert into public.folder_viewers (folder_id, user_id)
  select ${uuidSql(KIND.folder, "n * " + String(FOLDER_DEPTH))}, '${SCALE_CALLER}'
  from generate_series(0, ${Math.floor(folders / FOLDER_DEPTH / 2)}) n
  where n * ${FOLDER_DEPTH} < ${folders};
insert into public.doc (id, "folderId", "ownerId", restricted)
  select ${uuidSql(KIND.doc, "n")}, ${uuidSql(KIND.folder, `n % ${folders}`)}, null, false
  from generate_series(0, ${rows - 1}) n;
insert into public.employee (id, "orgId", "userId", "managerId")
  select ${uuidSql(KIND.employee, "n")}, ${tenant(`n % ${TENANTS}`)},
         case when n = 0 then '${SCALE_CALLER}'::uuid else ${uuidSql(KIND.user, "2000000 + n")} end,
         case when n % ${FOLDER_DEPTH} = 0 then null else ${uuidSql(KIND.employee, "n - 1")} end
  from generate_series(0, ${employees - 1}) n;
insert into storage.objects (bucket_id, name, owner)
  select 'files', ${tenant(`n % ${TENANTS}`)} || '/' || n || '.bin', '${SCALE_CALLER}'
  from generate_series(0, ${rows - 1}) n;
create index on public.item ("orgId");
create index on public.thread ("orgId");
create index on public.message ("threadId");
create index on public.doc ("folderId");
create index on public.organization_members (user_id, organization_id);
analyze;
`;
}
