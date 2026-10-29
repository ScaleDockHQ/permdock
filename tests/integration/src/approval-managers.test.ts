import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const REQUESTER = "00000000-0000-4000-8000-000000000001";
const LEAD = "00000000-0000-4000-8000-000000000002";
const HEAD = "00000000-0000-4000-8000-000000000003";
const CHIEF = "00000000-0000-4000-8000-000000000004";
const LOOP_A = "00000000-0000-4000-8000-000000000005";
const LOOP_B = "00000000-0000-4000-8000-000000000006";
const COVER = "00000000-0000-4000-8000-000000000007";
const LATE = "00000000-0000-4000-8000-000000000008";

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
create table public.reporting_lines (user_id uuid not null, manager_id uuid);
insert into public.reporting_lines values
  ('${REQUESTER}', '${LEAD}'),
  ('${LEAD}', '${HEAD}'),
  ('${HEAD}', '${CHIEF}'),
  ('${LOOP_A}', '${LOOP_B}'),
  ('${LOOP_B}', '${LOOP_A}'),
  ('${CHIEF}', null);
`;

const member = (sub: string) => ({
  sub,
  memberships: [{ scope: "tenant", id: "o1", roles: ["admin"] }],
});

let db: Postgres | undefined;

function started(): Postgres {
  if (db === undefined) {
    throw new Error("PermDock: Postgres was not started");
  }
  return db;
}

describe("approval managers", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-approval-managers-"));
    try {
      const out = join(dir, "rls.sql");
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", out],
        { cwd: join(HERE, "../fixtures/approval-managers-sql") },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}`);
      }
      db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await started().admin.query(
      `insert into permdock.approval_delegations (id, delegator, delegate, tenant, resources, "from", "until") values
      ('lead-away', $1, $2, 'o1', null, now() - interval '1 day', now() + interval '1 day'),
      ('lead-was-away', $1, $3, 'o1', null, now() - interval '3 days', now() - interval '1 day'),
      ('lead-away-elsewhere', $1, $3, 'o2', null, now() - interval '1 day', now() + interval '1 day')`,
      [LEAD, COVER, LATE],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function isApprover(
    user: string,
    approvers: unknown,
    requester: string,
  ): Promise<boolean> {
    const target = started();
    return target.as(
      {
        role: "authenticated",
        settings: { "request.jwt.claims": JSON.stringify(member(user)) },
      },
      async () => {
        const result = await target.tester.query<{ readonly ok: boolean }>(
          "select permdock.permdock_is_approver($1::jsonb, 'o1', $2, 'job') as ok",
          [JSON.stringify(approvers), requester],
        );
        return result.rows[0]?.ok === true;
      },
    );
  }

  const direct = { kind: "manager" };

  it("lets the requester's manager approve, up to levels", async () => {
    expect(await isApprover(LEAD, direct, REQUESTER)).toBe(true);
    expect(await isApprover(HEAD, direct, REQUESTER)).toBe(false);
    expect(
      await isApprover(HEAD, { kind: "manager", levels: 2 }, REQUESTER),
    ).toBe(true);
    expect(
      await isApprover(CHIEF, { kind: "manager", levels: 2 }, REQUESTER),
    ).toBe(false);
    expect(
      await isApprover(CHIEF, { kind: "manager", levels: 8 }, REQUESTER),
    ).toBe(true);
  });

  it("refuses levels outside 1 to 8, the requester, and stops at a cycle", async () => {
    for (const levels of [0, 9, 1.5, "2"]) {
      expect(
        await isApprover(HEAD, { kind: "manager", levels }, REQUESTER),
      ).toBe(false);
    }
    expect(
      await isApprover(LOOP_A, { kind: "manager", levels: 8 }, LOOP_A),
    ).toBe(false);
    expect(
      await isApprover(LOOP_B, { kind: "manager", levels: 8 }, LOOP_A),
    ).toBe(true);
    expect(
      await isApprover(REQUESTER, { kind: "manager", levels: 8 }, LOOP_A),
    ).toBe(false);
  });

  it("combines manager leaves with lists, any-of and other approvers", async () => {
    expect(
      await isApprover(
        HEAD,
        { kind: "any-of", of: [{ kind: "user", id: CHIEF }, direct] },
        LEAD,
      ),
    ).toBe(true);
    expect(
      await isApprover(LEAD, [direct, { kind: "user", id: HEAD }], REQUESTER),
    ).toBe(false);
    expect(
      await isApprover(LEAD, [direct, { kind: "user", id: LEAD }], REQUESTER),
    ).toBe(true);
  });

  it("lets a cover pass a manager leaf only for the delegator's reports, in its window and tenant", async () => {
    expect(await isApprover(COVER, { kind: "user", id: LEAD }, REQUESTER)).toBe(
      true,
    );
    expect(await isApprover(COVER, direct, REQUESTER)).toBe(true);
    expect(await isApprover(COVER, direct, LOOP_A)).toBe(false);
    expect(await isApprover(COVER, direct, LEAD)).toBe(false);
    expect(await isApprover(LATE, direct, REQUESTER)).toBe(false);
  });

  async function forStep(
    user: string,
    step: unknown,
    requester: string,
  ): Promise<boolean> {
    const target = started();
    return target.as(
      {
        role: "authenticated",
        settings: { "request.jwt.claims": JSON.stringify(member(user)) },
      },
      async () => {
        const result = await target.tester.query<{ readonly ok: boolean }>(
          "select permdock.permdock_is_approver(null, 'o1', $2, 'job', $1::jsonb) as ok",
          [JSON.stringify(step), requester],
        );
        return result.rows[0]?.ok === true;
      },
    );
  }

  it("checks covers against a block step's manager and users", async () => {
    expect(await forStep(COVER, { manager: true }, REQUESTER)).toBe(true);
    expect(await forStep(COVER, { users: [LEAD] }, LOOP_A)).toBe(true);
    expect(await forStep(COVER, { users: [HEAD] }, REQUESTER)).toBe(false);
    expect(await forStep(COVER, { manager: true }, LOOP_A)).toBe(false);
    expect(await forStep(LATE, { manager: true }, REQUESTER)).toBe(false);
    expect(await forStep(LEAD, { manager: true }, REQUESTER)).toBe(true);
  });

  it("keeps the manager walk away from client roles", async () => {
    const target = started();
    await expect(
      target.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": JSON.stringify(member(LEAD)) },
        },
        () =>
          target.tester.query("select permdock.permdock_manages($1, 1) as ok", [
            REQUESTER,
          ]),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
