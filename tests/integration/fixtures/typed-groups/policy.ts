import {
  allow,
  definePermissions,
  definePolicy,
  memoryRelations,
  relation,
  resource,
} from "permdock";
import { z } from "zod";

// A share table with one typed column per subject kind: `user_id text` for a
// person, `team_id bigint` for a team, and no column naming the kind.
const Team = z.object({ id: z.number() });
const Drive = z.object({ id: z.string() });

export const permissions = definePermissions({
  team: resource(Team, {
    actions: ["read"],
    relations: {
      member: {
        edge: "team_members",
        object: "team_id",
        subject: "user_id",
        groups: {
          resources: {
            team: { relation: "member", subject: "member_team_id" },
          },
        },
      },
    },
  }),
  drive: resource(Drive, {
    actions: ["read"],
    relations: {
      viewer: {
        edge: "drive_shares",
        object: "drive_id",
        subject: "user_id",
        expiresAt: "expires_at",
        groups: {
          resources: { team: { relation: "member", subject: "team_id" } },
        },
      },
    },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { org: { key: "orgId" } },
  grants: [
    allow(permissions.drive.read, {
      to: relation(permissions.drive, "viewer"),
    }),
    allow(permissions.team.read, {
      to: relation(permissions.team, "member"),
    }),
  ],
  subject: (user: { readonly id: string }) => ({ id: user.id }),
});

export const rows = {
  team: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  drive: [
    { id: "plans" },
    { id: "budget" },
    { id: "both" },
    { id: "lapsed" },
    { id: "none" },
  ],
};

type Row = Readonly<Record<string, string | number | null>>;

export const tables: Readonly<Record<string, readonly Row[]>> = {
  team_members: [
    { team_id: 1, user_id: "uma", member_team_id: null },
    { team_id: 1, user_id: null, member_team_id: 2 },
    { team_id: 2, user_id: "nina", member_team_id: null },
    { team_id: 2, user_id: null, member_team_id: 4 },
    { team_id: 3, user_id: "otis", member_team_id: null },
    { team_id: 4, user_id: "ivy", member_team_id: null },
  ],
  drive_shares: [
    { drive_id: "plans", user_id: "dana", team_id: null, expires_at: null },
    { drive_id: "budget", user_id: null, team_id: 1, expires_at: null },
    { drive_id: "both", user_id: "dana", team_id: 3, expires_at: null },
    { drive_id: "lapsed", user_id: "dana", team_id: 3, expires_at: 1000 },
    { drive_id: "none", user_id: null, team_id: null, expires_at: null },
  ],
};

export const relations = memoryRelations(permissions, { rows, tables });

export const users = ["dana", "uma", "nina", "ivy", "otis", "nobody"];

function literal(value: string | number | null): string {
  if (value === null) {
    return "null";
  }
  return typeof value === "string"
    ? `'${value.replaceAll("'", "''")}'`
    : String(value);
}

function insert(table: string, items: readonly Row[]): string {
  const first = items[0];
  if (first === undefined) {
    return "";
  }
  const columns = Object.keys(first);
  const values = items
    .map(
      (row) =>
        `(${columns
          .map((column) =>
            column === "expires_at" && typeof row[column] === "number"
              ? `to_timestamp(${String(row[column])})`
              : literal(row[column] ?? null),
          )
          .join(", ")})`,
    )
    .join(",\n  ");
  return `insert into ${table} (${columns.join(", ")}) values\n  ${values};`;
}

export const schemaSql = `
create table team (id bigint primary key);
create table drive (id text primary key);
create table team_members (
  team_id bigint not null references team (id),
  user_id text,
  member_team_id bigint references team (id),
  check ((user_id is null) <> (member_team_id is null))
);
create table drive_shares (
  drive_id text not null references drive (id),
  user_id text,
  team_id bigint references team (id),
  expires_at timestamptz
);
`;

export const seedSql = [
  insert("team", rows.team),
  insert("drive", rows.drive),
  insert("team_members", tables["team_members"] ?? []),
  insert("drive_shares", tables["drive_shares"] ?? []),
].join("\n");
