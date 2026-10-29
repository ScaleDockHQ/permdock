import type { Membership } from "permdock";

/**
 * One table, `file_nodes`, read by two resources (`file`, org-level, and
 * `fileNode`, per row) in `split/` and by one merged `file` in `merged/`.
 */
export type FileUser = {
  readonly id: string;
  readonly tenant?: string;
  readonly memberships: readonly Membership[];
};

export type FileRow = {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly ownerId: string | null;
};

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const users: readonly FileUser[] = [
  {
    id: uuid(1),
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
  },
  {
    id: uuid(2),
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["member"] }],
  },
  { id: uuid(3), memberships: [] },
  { id: uuid(4), memberships: [] },
  {
    id: uuid(5),
    tenant: "other",
    memberships: [{ scope: "tenant", id: "other", roles: ["member"] }],
  },
];

export const rows: readonly FileRow[] = [
  { id: "r1", orgId: "acme", parentId: null, ownerId: uuid(3) },
  { id: "r2", orgId: "acme", parentId: "r1", ownerId: null },
  { id: "r3", orgId: "acme", parentId: null, ownerId: null },
  { id: "r4", orgId: "acme", parentId: "r3", ownerId: null },
  { id: "r5", orgId: "acme", parentId: "r4", ownerId: uuid(1) },
  { id: "o1", orgId: "other", parentId: null, ownerId: null },
  { id: "o2", orgId: "other", parentId: "o1", ownerId: uuid(3) },
];

export const shares: readonly {
  readonly object_id: string;
  readonly user_id: string;
}[] = [
  { object_id: "r3", user_id: uuid(4) },
  { object_id: "r1", user_id: uuid(5) },
];

export const subject = (user: FileUser) => ({
  id: user.id,
  ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
  memberships: user.memberships,
});

const literal = (value: string | null): string =>
  value === null ? "null" : `'${value}'`;

export const setupSql = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${users.map((user) => `('${user.id}')`).join(", ")};
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
${users
  .flatMap((user) =>
    user.memberships.flatMap((membership) =>
      membership.roles.map(
        (name) =>
          `  ('${membership.within?.["tenant"] ?? membership.id ?? ""}', '${user.id}', '${name}')`,
      ),
    ),
  )
  .join(",\n")};
create table public.file_nodes (
  id text primary key,
  "orgId" text not null,
  "parentId" text,
  "ownerId" uuid
);
create table public.file_node_shares (object_id text not null, user_id uuid not null);
insert into public.file_nodes values ${rows.map((row) => `('${row.id}', '${row.orgId}', ${literal(row.parentId)}, ${literal(row.ownerId)})`).join(", ")};
insert into public.file_node_shares values ${shares.map((row) => `('${row.object_id}', '${row.user_id}')`).join(", ")};
grant select on public.file_nodes, public.file_node_shares to authenticated;
`;
