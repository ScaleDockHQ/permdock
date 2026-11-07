import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";
const U4 = "00000000-0000-4000-8000-000000000004";
const UA = "00000000-0000-4000-8000-0000000000a1";
const UB = "00000000-0000-4000-8000-0000000000b1";
const UC = "00000000-0000-4000-8000-0000000000c1";

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
create table public.employee (
  id text primary key,
  "orgId" text not null,
  "userId" uuid not null,
  "managerId" text
);
insert into public.employee (id, "orgId", "userId", "managerId") values
  ('e1', 'o1', '${U1}', null),
  ('e2', 'o1', '${U2}', 'e1'),
  ('e3', 'o1', '${U3}', 'e2'),
  ('e4', 'o2', '${U4}', 'e1'),
  ('ca', 'o1', '${UA}', 'cb'),
  ('cb', 'o1', '${UB}', 'ca'),
  ('cc', 'o1', '${UC}', 'cc');
`;

let db: Postgres | undefined;

function started(): Postgres {
  if (db === undefined) {
    throw new Error("PermDock: Postgres was not started");
  }
  return db;
}

describe("walk: recursive chain", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-walk-chain-"));
    try {
      const out = join(dir, "rls.sql");
      const result = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd: join(HERE, "../fixtures/walk-chain"),
      });
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}`);
      }
      db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function chainOf(user: string): Promise<string[]> {
    const target = started();
    return target.as(
      {
        role: "authenticated",
        settings: { "request.jwt.claims": JSON.stringify({ sub: user }) },
      },
      async () => {
        await target.tester.query("set local statement_timeout = '2s'");
        const result = await target.tester.query<{ readonly id: string }>(
          "select permdock.permdock_employee_chain() as id",
        );
        return result.rows.map((row) => row.id).toSorted();
      },
    );
  }

  it("starts at the caller's employee row, whose id is not the user id, and stays in its tenant", async () => {
    expect(await chainOf(U1)).toStrictEqual(["e2", "e3"]);
    expect(await chainOf(U2)).toStrictEqual(["e3"]);
    expect(await chainOf(U3)).toStrictEqual([]);
  });

  it("returns on a cycle and on a self-parented row", async () => {
    expect(await chainOf(UA)).toStrictEqual(["cb"]);
    expect(await chainOf(UC)).toStrictEqual([]);
  });

  it("adds the delegator's own row and every row below it for an active cover", async () => {
    await started().admin.query(
      `insert into permdock.approval_delegations (id, delegator, delegate, tenant, resources, "from", "until") values
      ('u2-away', $1, $2, 'o1', null, now() - interval '1 day', now() + interval '1 day'),
      ('u1-was-away', $3, $2, 'o1', null, now() - interval '3 days', now() - interval '1 day')`,
      [U2, U4, U1],
    );
    expect(await chainOf(U4)).toStrictEqual(["e2", "e3"]);
  });
});
