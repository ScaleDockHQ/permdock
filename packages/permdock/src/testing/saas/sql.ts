import type { SaasSeed } from './seed.ts';

import { saasSeed } from './seed.ts';

/**
 * Postgres tables for the SaaS domain. Column names match the resource
 * fields (`"orgId"`, `"ownerId"`) so generated RLS and ORM filters compile
 * against them without a column map. RLS is enabled and forced on the row
 * tables; policies come from `permdock rls generate`.
 */
export const saasSchemaSql = `
create table org (
  id text primary key,
  name text not null,
  plan text not null check (plan in ('free', 'pro'))
);
create table org_member (
  user_id text not null,
  org_id text references org (id),
  team_id text,
  resource text,
  resource_id text,
  role text not null,
  expires_at bigint
);
create table project (
  id text primary key,
  "orgId" text not null references org (id),
  "ownerId" text not null,
  name text not null,
  archived boolean not null default false
);
alter table project enable row level security;
alter table project force row level security;
create table doc (
  id text primary key,
  "orgId" text not null references org (id),
  "teamId" text,
  title text not null,
  locked boolean not null default false
);
alter table doc enable row level security;
alter table doc force row level security;
`;

function literal(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('PermDock: non-finite number in fixture seed');
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function values(rows: readonly (readonly unknown[])[]): string {
  return rows
    .map(
      (row) =>
        `(${row.map((cell) => literal(cell as string | number | boolean | null)).join(', ')})`,
    )
    .join(',\n  ');
}

/** `insert` statements for a seed; the default is the full shared seed. */
export function saasSeedSql(seed: SaasSeed = saasSeed): string {
  const members = seed.members.flatMap((member) =>
    member.roles.map((role) => [
      member.user,
      member.tenant,
      member.team ?? null,
      member.on?.resource ?? null,
      member.on?.id ?? null,
      role,
      member.expiresAt ?? null,
    ]),
  );
  const statements = [
    `insert into org (id, name, plan) values\n  ${values(seed.orgs.map((org) => [org.id, org.name, org.plan]))};`,
  ];
  if (members.length > 0) {
    statements.push(
      `insert into org_member (user_id, org_id, team_id, resource, resource_id, role, expires_at) values\n  ${values(members)};`,
    );
  }
  if (seed.projects.length > 0) {
    statements.push(
      `insert into project (id, "orgId", "ownerId", name, archived) values\n  ${values(
        seed.projects.map((row) => [
          row.id,
          row.orgId,
          row.ownerId,
          row.name,
          row.archived,
        ]),
      )};`,
    );
  }
  if (seed.docs.length > 0) {
    statements.push(
      `insert into doc (id, "orgId", "teamId", title, locked) values\n  ${values(
        seed.docs.map((row) => [
          row.id,
          row.orgId,
          row.teamId,
          row.title,
          row.locked,
        ]),
      )};`,
    );
  }
  return `${statements.join('\n')}\n`;
}
