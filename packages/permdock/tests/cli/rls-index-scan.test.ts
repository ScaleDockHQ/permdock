import { describe, expect, it } from "vitest";

import {
  indexKeysFromSql,
  withoutServedTargets,
} from "../../src/cli/rls/index-scan.ts";

const SQL = `
-- create index on public.ignored (x);
create table public.organization_members (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  constraint organization_members_unique unique (user_id, role_id, organization_id)
);
create unique index concurrently if not exists "jobs_owner" on only app.jobs using btree ("owner_id" desc, lower(name));
create index on jobs (org_id, (created_at::date));
alter table public.teams add constraint teams_pkey primary key (id);
create table other (code text unique, check (code <> ''), foreign key (code) references x(c));
`;

describe("indexKeysFromSql", () => {
  it("reads indexes, constraints and keys, cut at the first expression", () => {
    expect(indexKeysFromSql(SQL)).toEqual({
      "public.organization_members": [
        ["id"],
        ["user_id", "role_id", "organization_id"],
      ],
      "app.jobs": [["owner_id"]],
      "public.jobs": [["org_id"]],
      "public.teams": [["id"]],
      "public.other": [["code"]],
    });
  });

  it("drops the targets an index leads with and keeps the rest", () => {
    const keys = indexKeysFromSql(SQL);
    expect(
      withoutServedTargets(
        [
          { table: "public.organization_members", columns: ["user_id"] },
          {
            table: "public.organization_members",
            columns: ["user_id", "organization_id"],
          },
          { table: "public.jobs", columns: ["owner_id"] },
        ],
        keys,
      ),
    ).toEqual([
      {
        table: "public.organization_members",
        columns: ["user_id", "organization_id"],
      },
      { table: "public.jobs", columns: ["owner_id"] },
    ]);
  });
});
