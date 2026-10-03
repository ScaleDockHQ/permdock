import type { RlsParityFixture } from "permdock/testing";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { rlsParity } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/canonical-ids/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/canonical-ids");

const ORG_A = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const ORG_B = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const USER = "00000000-0000-4000-8000-0000000000c1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
create table doc (id text primary key, "orgId" uuid not null);
insert into doc values ('d-a', '${ORG_A}'), ('d-b', '${ORG_B}');
`;

const GRANTS = "grant select on doc to authenticated;";

function read(
  name: string,
  tenant: string,
  row: { readonly id: string; readonly orgId: string },
): RlsParityFixture {
  return {
    name,
    subject: {
      id: USER,
      tenant,
      memberships: [{ tenant, roles: ["member"] }],
    },
    permission: permissions.doc.read,
    row,
    table: "doc",
  };
}

describe("RLS parity for uuid tenant ids", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-ids-"));
    const out = join(dir, "rls.sql");
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--out",
        out,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const generated = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated, GRANTS]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("matches uuid::text ids from the claim against a uuid column", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    const report = await rlsParity(policy, {
      dialect: "supabase",
      snapshot: true,
      fixtures: [
        read("member reads its tenant", ORG_A, { id: "d-a", orgId: ORG_A }),
        read("member reads nothing in another tenant", ORG_A, {
          id: "d-b",
          orgId: ORG_B,
        }),
      ],
      query: async (sql, values) => {
        const result = await client.query(
          sql,
          values === undefined ? undefined : [...values],
        );
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    });
    expect(report.results.map((item) => [item.name, item.granted])).toEqual([
      ["member reads its tenant", true],
      ["member reads nothing in another tenant", false],
    ]);
    expect(report.results.filter((item) => !item.ok)).toEqual([]);
  });
});
