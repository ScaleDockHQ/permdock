import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { tableApprovalDelegationSource } from "permdock/supabase";
import { testApprovalDelegationSource } from "permdock/testing";
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

const LEAD = "00000000-0000-4000-8000-000000000001";
const COVER = "00000000-0000-4000-8000-000000000002";
const REQUESTER = "00000000-0000-4000-8000-000000000003";
const SECOND = "00000000-0000-4000-8000-000000000004";
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

describe("approval delegations", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-approval-delegations-"));
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
      `insert into permdock.approval_delegations (id, delegator, delegate, tenant, resources, "from", "until") values
      ('active', $1, $2, 'o1', array['job'], now() - interval '1 day', now() + interval '1 day'),
      ('expired', $1, $3, null, null, now() - interval '2 days', now() - interval '1 day'),
      ('second-hop', $2, $3, null, null, now() - interval '1 day', now() + interval '1 day')`,
      [LEAD, COVER, SECOND],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function isApprover(
    user: string,
    approvers: unknown,
    tenant: string | null,
    requester: string,
    resource = "job",
  ): Promise<boolean> {
    const target = started();
    return target.as(
      {
        role: "authenticated",
        settings: { "request.jwt.claims": JSON.stringify(member(user)) },
      },
      async () => {
        const result = await target.tester.query<{ readonly ok: boolean }>(
          "select permdock.permdock_is_approver($1::jsonb, $2, $3, $4) as ok",
          [JSON.stringify(approvers), tenant, requester, resource],
        );
        return result.rows[0]?.ok === true;
      },
    );
  }

  describe("permdock_is_approver with covers", () => {
    const lead = { kind: "user", id: LEAD };

    it("lets a delegate approve inside an active cover for the resource and tenant", async () => {
      expect(await isApprover(LEAD, lead, "o1", REQUESTER)).toBe(true);
      expect(await isApprover(COVER, lead, "o1", REQUESTER)).toBe(true);
      expect(await isApprover(COVER, lead, "o2", REQUESTER)).toBe(false);
      expect(await isApprover(COVER, lead, "o1", REQUESTER, "invoice")).toBe(
        false,
      );
    });

    it("refuses an expired cover, a delegator who asked, and a second hop", async () => {
      expect(await isApprover(SECOND, lead, "o1", REQUESTER)).toBe(false);
      expect(await isApprover(COVER, lead, "o1", LEAD)).toBe(false);
      expect(
        await isApprover(SECOND, { kind: "user", id: COVER }, "o1", REQUESTER),
      ).toBe(true);
      expect(await isApprover(COVER, lead, "o1", "")).toBe(false);
    });

    async function forStep(
      user: string,
      step: unknown,
      tenant: string,
      requester: string,
      resource = "job",
    ): Promise<boolean> {
      const target = started();
      return target.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": JSON.stringify(member(user)) },
        },
        async () => {
          const result = await target.tester.query<{ readonly ok: boolean }>(
            "select permdock.permdock_is_approver(null, $2, $3, $4, $1::jsonb) as ok",
            [JSON.stringify(step), tenant, requester, resource],
          );
          return result.rows[0]?.ok === true;
        },
      );
    }

    it("checks covers against the users of a block step", async () => {
      const step = { users: [LEAD], required: 1 };
      expect(await forStep(LEAD, step, "o1", REQUESTER)).toBe(true);
      expect(await forStep(COVER, step, "o1", REQUESTER)).toBe(true);
      expect(
        await forStep(COVER, { users: [REQUESTER] }, "o1", REQUESTER),
      ).toBe(false);
      expect(await forStep(COVER, null, "o1", REQUESTER)).toBe(false);
    });

    it("refuses a step cover outside its window, tenant or resources, or for the requester's delegator", async () => {
      const step = { users: [LEAD] };
      expect(await forStep(SECOND, step, "o1", REQUESTER)).toBe(false);
      expect(await forStep(COVER, step, "o2", REQUESTER)).toBe(false);
      expect(await forStep(COVER, step, "o1", REQUESTER, "invoice")).toBe(
        false,
      );
      expect(await forStep(COVER, step, "o1", LEAD)).toBe(false);
      expect(await forStep(COVER, { manager: true }, "o1", REQUESTER)).toBe(
        false,
      );
    });

    it("keeps the two-argument check free of covers", async () => {
      const target = started();
      const ok = await target.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": JSON.stringify(member(COVER)) },
        },
        async () =>
          (
            await target.tester.query<{ readonly ok: boolean }>(
              "select permdock.permdock_is_approver($1::jsonb, 'o1') as ok",
              [JSON.stringify(lead)],
            )
          ).rows[0]?.ok,
      );
      expect(ok).toBe(false);
    });
  });

  describe("approval_delegations policies", () => {
    async function asUser<T>(
      user: string,
      work: (target: Postgres) => Promise<T>,
    ): Promise<T> {
      const target = started();
      return target.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": JSON.stringify(member(user)) },
        },
        () => work(target),
      );
    }

    it("lets a user write covers for themselves in their own tenants", async () => {
      const inserted = await asUser(REQUESTER, async (target) => {
        await target.tester.query(
          `insert into permdock.approval_delegations (delegate, tenant, "until") values ($1, 'o1', now() + interval '1 day')`,
          [COVER],
        );
        const { rows } = await target.tester.query<{
          readonly delegator: string;
        }>(
          "select delegator::text from permdock.approval_delegations where delegate = $1",
          [COVER],
        );
        return rows.map((row) => row.delegator);
      });
      expect(inserted).toStrictEqual([REQUESTER]);
    });

    it("refuses a cover for someone else, in another tenant, and hides others' covers", async () => {
      await expect(
        asUser(REQUESTER, (target) =>
          target.tester.query(
            `insert into permdock.approval_delegations (delegator, delegate, "until") values ($1, $2, now() + interval '1 day')`,
            [LEAD, REQUESTER],
          ),
        ),
      ).rejects.toThrow(/row-level security/u);
      await expect(
        asUser(REQUESTER, (target) =>
          target.tester.query(
            `insert into permdock.approval_delegations (delegate, tenant, "until") values ($1, 'o2', now() + interval '1 day')`,
            [COVER],
          ),
        ),
      ).rejects.toThrow(/row-level security/u);
      const seen = await asUser(
        REQUESTER,
        async (target) =>
          (
            await target.tester.query(
              "select id from permdock.approval_delegations",
            )
          ).rowCount,
      );
      expect(seen).toBe(0);
    });
  });

  describe("tableApprovalDelegationSource over the generated table", () => {
    const source = tableApprovalDelegationSource({
      query: (text, values) => started().admin.query(text, [...values]),
    });

    testApprovalDelegationSource(source, {
      delegate: COVER,
      delegator: LEAD,
      tenant: "o1",
    });

    it("returns only the active covers for the tenant", async () => {
      const at = new Date().toISOString();
      expect(
        (await source.delegationsFor({ delegate: SECOND, at })).map(
          (entry) => entry.id,
        ),
      ).toStrictEqual(["second-hop"]);
      expect(
        await source.delegationsFor({ delegate: COVER, at }),
      ).toStrictEqual([]);
    });
  });
});
