import type { Client } from "pg";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testRlsParity } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions } from "../fixtures/sql-set/permissions.ts";
import { policy } from "../fixtures/sql-set/policy.ts";
import { defined } from "./support/defined.ts";
import { startPostgres } from "./support/postgres.ts";
import { generateRls } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/sql-set");

const USER = "u1";
const OTHER = "u9";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table public.file (
  id text primary key,
  "ownerId" text not null
);
insert into public.file (id, "ownerId") values
  ('f1', '${USER}'),
  ('f2', '${USER}'),
  ('f3', '${OTHER}');
alter table public.file enable row level security;
alter table public.file force row level security;
create function public.file_ids_for(p_permission text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select id from public.file
  where "ownerId" = current_setting('app.user_id', true)
    and p_permission = 'read'
$$;
grant execute on function public.file_ids_for(text) to authenticated;
grant select on public.file to authenticated;
`;

type PlanNode = {
  readonly "Node Type": string;
  readonly "Actual Loops"?: number;
  readonly "Function Name"?: string;
  readonly Output?: readonly string[];
  readonly "Subplan Name"?: string;
  readonly Plans?: readonly PlanNode[];
};

type Explain = { readonly Plan: PlanNode };

function nodes(plan: PlanNode): readonly PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function callsHelper(node: PlanNode, helper: string): boolean {
  return (
    node["Function Name"] === helper ||
    (node.Output ?? []).some((item) => item.includes(`${helper}(`))
  );
}

describe("a sqlFunction set variant in generated RLS", () => {
  let db: Postgres | undefined;
  let generated = "";

  async function asUser<T>(work: (client: Client) => Promise<T>): Promise<T> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    return target.as(
      {
        role: "authenticated",
        settings: {
          "app.user_id": USER,
          "app.user_role": "member",
          "app.memberships": "[]",
        },
      },
      () => work(target.tester),
    );
  }

  beforeAll(async () => {
    generated = await generateRls(FIXTURE, ["--dialect", "guc"]);
    db = await startPostgres([SETUP, generated, "analyze"]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("writes the set as an in-subquery", () => {
    expect(generated).toContain(`"id" in (select "file_ids_for"('read'))`);
    expect(generated).not.toContain(`"file_ids_for"("id")`);
  });

  it("returns the same rows as can()", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const report = await testRlsParity(policy, {
      dialect: "guc",
      fixtures: [
        {
          name: "member reads its own file",
          subject: { id: USER, roles: ["member"] },
          permission: permissions.file.read,
          row: { id: "f1", ownerId: USER },
          table: "file",
        },
        {
          name: "member reads nothing owned by another user",
          subject: { id: USER, roles: ["member"] },
          permission: permissions.file.read,
          row: { id: "f3", ownerId: OTHER },
          table: "file",
        },
        {
          name: "the other user reads its own file",
          subject: { id: OTHER, roles: ["member"] },
          permission: permissions.file.read,
          row: { id: "f3", ownerId: OTHER },
          table: "file",
        },
      ],
      query: async (sql, values) => {
        const result = await target.tester.query(
          sql,
          values === undefined ? undefined : [...values],
        );
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    });
    expect(report.results.map((item) => [item.name, item.ok])).toStrictEqual([
      ["member reads its own file", true],
      ["member reads nothing owned by another user", true],
      ["the other user reads its own file", true],
    ]);
  });

  it("plans one SubPlan that calls the helper once", async () => {
    const ids = await asUser(async (client) => {
      const result = await client.query<{ readonly id: string }>(
        "select id from public.file order by id",
      );
      return result.rows.map((row) => row.id);
    });
    expect(ids).toStrictEqual(["f1", "f2"]);
    const plan = await asUser(async (client) => {
      const result = await client.query<{ readonly "QUERY PLAN": Explain[] }>(
        "explain (analyze, verbose, format json) select id from public.file",
      );
      return result.rows[0]?.["QUERY PLAN"][0];
    });
    const all = nodes(defined(plan).Plan);
    const subplans = all.filter(
      (node) => node["Subplan Name"]?.includes("SubPlan") === true,
    );
    expect(subplans).toHaveLength(1);
    expect(subplans[0]?.["Actual Loops"]).toBe(1);
    const calls = all.filter((node) => callsHelper(node, "file_ids_for"));
    expect(calls.length).toBeGreaterThan(0);
    for (const node of calls) {
      expect(node["Actual Loops"]).toBe(1);
    }
  });
});
