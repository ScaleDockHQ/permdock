import type { SqlQuery } from "permdock/supabase";

import { blockMembershipSource } from "permdock/better-supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const OWNER = "00000000-0000-4000-8000-0000000000b1";
const CUSTOM = "00000000-0000-4000-8000-0000000000b2";
const MULTI = "00000000-0000-4000-8000-0000000000b3";
const GONE = "00000000-0000-4000-8000-0000000000b4";
const ORG = "00000000-0000-4000-8000-00000000000a";

// The shape `better-supabase add memberships` installs, plus an app roles
// table for `roleThrough` and a role junction for several roles per member.
const SETUP = `
create schema better_supabase;
create table better_supabase.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  role text,
  disabled_at timestamptz
);
create table public.roles (id text primary key, key text not null);
insert into public.roles values ('r-1', 'owner'), ('r-2', 'quote-approver');
create table public.membership_roles (membership_id uuid not null, role text not null);
insert into better_supabase.memberships (id, organization_id, user_id, role, disabled_at) values
  ('00000000-0000-4000-8000-0000000000c1', '${ORG}', '${OWNER}', 'owner', null),
  ('00000000-0000-4000-8000-0000000000c2', '${ORG}', '${CUSTOM}', 'quote-approver', null),
  ('00000000-0000-4000-8000-0000000000c3', '${ORG}', '${MULTI}', 'member', null),
  ('00000000-0000-4000-8000-0000000000c4', '${ORG}', '${GONE}', 'owner', now());
insert into public.membership_roles values
  ('00000000-0000-4000-8000-0000000000c3', 'member'),
  ('00000000-0000-4000-8000-0000000000c3', 'billing');
`;

let db: Postgres;
let query: SqlQuery;

beforeAll(async () => {
  db = await startPostgres([SETUP]);
  query = async (text, values) =>
    (await db.admin.query(text, [...values])).rows;
}, 120_000);

afterAll(async () => {
  await db.stop();
});

describe("blockMembershipSource against better-supabase's memberships table", () => {
  it("reads role keys and drops disabled rows", async () => {
    const source = blockMembershipSource({ query });
    expect(await source.membershipsFor({ id: OWNER }, {})).toStrictEqual([
      { scope: "organization", id: ORG, roles: ["owner"] },
    ]);
    expect(await source.membershipsFor({ id: GONE }, {})).toStrictEqual([]);
  });

  it("reads custom roles through roleThrough", async () => {
    await db.admin.query(
      `update better_supabase.memberships set role = case role when 'owner' then 'r-1' when 'quote-approver' then 'r-2' else role end`,
    );
    try {
      const source = blockMembershipSource({
        query,
        roleThrough: { table: "public.roles", id: "id", column: "key" },
      });
      expect(await source.membershipsFor({ id: CUSTOM }, {})).toStrictEqual([
        { scope: "organization", id: ORG, roles: ["quote-approver"] },
      ]);
    } finally {
      await db.admin.query(
        `update better_supabase.memberships set role = case role when 'r-1' then 'owner' when 'r-2' then 'quote-approver' else role end`,
      );
    }
  });

  it("merges every role of a junction into one membership", async () => {
    const source = blockMembershipSource({
      query,
      roles: {
        table: "public.membership_roles",
        membership: "membership_id",
        role: "role",
      },
    });
    expect(await source.membershipsFor({ id: MULTI }, {})).toStrictEqual([
      { scope: "organization", id: ORG, roles: ["billing", "member"] },
    ]);
    expect(
      (await source.list?.({ scope: "organization", id: ORG }))?.map(
        (entry) => entry.principal.id,
      ),
    ).toStrictEqual([MULTI]);
  });
});
