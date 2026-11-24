import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ANNA = "00000000-0000-4000-8000-000000000001";
const BEN = "00000000-0000-4000-8000-000000000002";
const CLEO = "00000000-0000-4000-8000-000000000003";
const DAN = "00000000-0000-4000-8000-000000000004";
const COVER = "00000000-0000-4000-8000-000000000005";
const GONE = "00000000-0000-4000-8000-000000000006";

// Anna manages Ben, Ben manages Cleo; Dan reported to Gone, whose row has ended.
const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.employees (
  id text primary key,
  manager_employee_id text references public.employees (id),
  user_id uuid,
  org text not null,
  status text not null default 'active'
);
insert into public.employees values
  ('e-anna', null, '${ANNA}', 'o1', 'active'),
  ('e-ben', 'e-anna', '${BEN}', 'o1', 'active'),
  ('e-cleo', 'e-ben', '${CLEO}', 'o1', 'active'),
  ('e-gone', null, '${GONE}', 'o1', 'ended'),
  ('e-dan', 'e-gone', '${DAN}', 'o1', 'active');
`;

let db: Postgres | undefined;

function started(): Postgres {
  if (db === undefined) {
    throw new Error("PermDock: Postgres was not started");
  }
  return db;
}

async function as<T extends Record<string, unknown>>(
  user: string,
  sql: string,
  values: unknown[] = [],
): Promise<readonly T[]> {
  const target = started();
  return target.as(
    {
      role: "authenticated",
      settings: {
        "request.jwt.claims": JSON.stringify({
          sub: user,
          memberships: [{ scope: "tenant", id: "o1", roles: ["admin"] }],
        }),
      },
    },
    async () => (await target.tester.query<T>(sql, values)).rows,
  );
}

describe("approval managers on a self-referencing table", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-approval-chain-"));
    try {
      const out = join(dir, "rls.sql");
      const result = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd: join(HERE, "../fixtures/approval-chain-sql"),
      });
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}`);
      }
      db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await started().admin.query(
      `insert into permdock.approval_delegations (id, delegator, delegate, tenant, resources, "from", "until") values
      ('ben-away', $1, $2, 'o1', null, now() - interval '1 day', now() + interval '1 day')`,
      [BEN, COVER],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("answers whether the caller manages a row, up the chain", async () => {
    const manages = async (user: string, row: string): Promise<boolean> =>
      (
        await as<{ ok: boolean }>(
          user,
          "select permdock.permdock_manages_row($1) as ok",
          [row],
        )
      )[0]?.ok === true;
    expect(await manages(ANNA, "e-cleo")).toBe(true);
    expect(await manages(BEN, "e-cleo")).toBe(true);
    expect(await manages(CLEO, "e-cleo")).toBe(false);
    expect(await manages(CLEO, "e-anna")).toBe(false);
    expect(await manages(GONE, "e-dan")).toBe(false);
  });

  it("lists the rows below the caller, never the caller's own", async () => {
    const ids = async (user: string, sql: string): Promise<string[]> =>
      (await as<{ id: string }>(user, sql)).map((row) => row.id).toSorted();
    expect(
      await ids(
        ANNA,
        "select permdock.permdock_managed_row_ids_in('o1') as id",
      ),
    ).toStrictEqual(["e-ben", "e-cleo"]);
    expect(
      await ids(
        ANNA,
        "select permdock.permdock_managed_row_ids_in('o2') as id",
      ),
    ).toStrictEqual([]);
    expect(
      await ids(BEN, "select permdock.permdock_managed_row_ids() as id"),
    ).toStrictEqual(["e-cleo"]);
    expect(
      await ids(
        BEN,
        "select permdock.permdock_accessible_row_ids('job.read') as id",
      ),
    ).toContain("e-ben");
  });

  it("names the requester's managers and their covers as approvers", async () => {
    const approvers = (
      await as<{ id: string }>(
        CLEO,
        "select permdock.permdock_request_approver_ids($1, 'o1') as id",
        [CLEO],
      )
    )
      .map((row) => row.id)
      .toSorted();
    expect(approvers).toStrictEqual([ANNA, BEN, COVER].toSorted());
    expect(
      await as(
        DAN,
        "select permdock.permdock_request_approver_ids($1, 'o1') as id",
        [DAN],
      ),
    ).toStrictEqual([]);
  });
});
