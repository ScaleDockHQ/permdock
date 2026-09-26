import type { ItemMember, ItemRow } from './policy.ts';

import { itemMembers, itemRows } from './policy.ts';

/** Column names match the condition fields, so no column map is needed. */
export const itemSchemaSql = `
create table item (
  id text primary key,
  "orgId" text not null,
  "teamId" text,
  "folderId" text,
  owner text,
  status text,
  score integer,
  title text not null,
  tags text[],
  due timestamptz,
  archived boolean
);
create table item_member (
  user_id text not null,
  org_id text,
  team_id text,
  resource text,
  resource_id text,
  role text not null,
  expires_at bigint
);
`;

type Cell = string | number | boolean | Date | readonly string[] | null;

function literal(value: Cell | undefined): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'::timestamptz`;
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? `'{}'::text[]`
      : `array[${value.map((item) => literal(item)).join(', ')}]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tuple(cells: readonly (Cell | undefined)[]): string {
  return `(${cells.map((cell) => literal(cell)).join(', ')})`;
}

export function itemSeedSql(
  rows: readonly ItemRow[] = itemRows,
  members: readonly ItemMember[] = itemMembers,
): string {
  const items = rows.map((row) =>
    tuple([
      row.id,
      row.orgId,
      row.teamId,
      row.folderId,
      row.owner,
      row.status,
      row.score,
      row.title,
      row.tags,
      row.due,
      row.archived,
    ]),
  );
  const grants = members.flatMap((member) =>
    member.roles.map((role) =>
      tuple([
        member.user,
        member.tenant,
        member.team,
        member.on?.resource,
        member.on?.id,
        role,
        member.expiresAt,
      ]),
    ),
  );
  return [
    `insert into item (id, "orgId", "teamId", "folderId", owner, status, score, title, tags, due, archived) values\n  ${items.join(',\n  ')};`,
    `insert into item_member (user_id, org_id, team_id, resource, resource_id, role, expires_at) values\n  ${grants.join(',\n  ')};`,
  ].join('\n');
}
