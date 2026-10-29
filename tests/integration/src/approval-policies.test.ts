import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { tableApprovalPolicySource } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

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
`;

const ADMIN = "00000000-0000-4000-8000-000000000001";
const STEWARD = "00000000-0000-4000-8000-000000000002";
const claims = (sub: string, roles: readonly string[]) => ({
  sub,
  memberships: [{ scope: "tenant", id: "o1", roles: [...roles] }],
});

const floor = {
  permission: "job.update",
  approval: { by: { kind: "role", role: "admin", scope: "tenant" } },
};
const tightening = { permission: "job.update", approval: { quorum: 2 } };

let db: Postgres | undefined;

function started(): Postgres {
  if (db === undefined) {
    throw new Error("PermDock: Postgres was not started");
  }
  return db;
}

async function asUser<T>(
  sub: string,
  roles: readonly string[],
  work: (target: Postgres) => Promise<T>,
): Promise<T> {
  const target = started();
  return target.as(
    {
      role: "authenticated",
      settings: { "request.jwt.claims": JSON.stringify(claims(sub, roles)) },
    },
    () => work(target),
  );
}

describe("rls.approvals.tenantPolicies", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-approval-policies-"));
    try {
      const out = join(dir, "rls.sql");
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", out],
        { cwd: join(HERE, "../fixtures/approval-delegations-sql") },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}`);
      }
      db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await started().admin.query(
      `insert into permdock.approval_policies (id, tenant, name, body, enabled) values
      ('floor', null, 'Platform floor', $1::jsonb, true),
      ('mine', 'o1', 'Two approvers', $2::jsonb, true),
      ('other', 'o2', 'Other tenant', $2::jsonb, true),
      ('off', 'o1', 'Disabled', $2::jsonb, false)`,
      [JSON.stringify(floor), JSON.stringify(tightening)],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("lets a holder of manage write the tenant's own policies", async () => {
    const names = await asUser(ADMIN, ["admin"], async (target) => {
      await target.tester.query(
        `insert into permdock.approval_policies (id, tenant, name, body) values ('added', 'o1', 'Added', $1::jsonb)`,
        [JSON.stringify(tightening)],
      );
      const { rows } = await target.tester.query<{ readonly id: string }>(
        "select id from permdock.approval_policies order by id",
      );
      return rows.map((row) => row.id);
    });
    expect(names).toStrictEqual(["added", "floor", "mine", "off"]);
  });

  it("refuses a floor, another tenant's row and a member without manage", async () => {
    for (const [sub, roles, tenant] of [
      [ADMIN, ["admin"], null],
      [ADMIN, ["admin"], "o2"],
      [STEWARD, ["steward"], "o1"],
    ] as const) {
      await expect(
        asUser(sub, roles, (target) =>
          target.tester.query(
            `insert into permdock.approval_policies (tenant, name, body) values ($1, 'x', $2::jsonb)`,
            [tenant, JSON.stringify(tightening)],
          ),
        ),
      ).rejects.toThrow(/row-level security/u);
    }
    await expect(
      started().admin.query(
        `insert into permdock.approval_policies (tenant, name, body) values ('o1', 'x', '{"permission":"job.update"}')`,
      ),
    ).rejects.toThrow(/approval_policies_body/u);
  });

  it("keeps permdock_approval_policies_for to the owner", async () => {
    await expect(
      asUser(ADMIN, ["admin"], (target) =>
        target.tester.query(
          "select * from permdock.permdock_approval_policies_for(array['o2'])",
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it("reads the floors and the enabled policies of the given tenants through tableApprovalPolicySource", async () => {
    const source = tableApprovalPolicySource({
      query: (text, values) => started().admin.query(text, [...values]),
    });
    expect(await source.approvalPoliciesFor({ tenants: ["o1"] })).toStrictEqual(
      [floor, { ...tightening, tenant: "o1" }],
    );
    expect(
      await source.approvalPoliciesFor({ tenants: ["o1", "o2"] }),
    ).toHaveLength(3);
    expect(await source.approvalPoliciesFor({ tenants: [] })).toStrictEqual([
      floor,
    ]);
  });
});
