import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/ownership/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/ownership",
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
create table org_members (org_id text not null, user_id text not null, role text not null);
create table payment (id text primary key, org_id text not null);
insert into org_members values
  ('o1', 'u1', 'primary'), ('o1', 'u2', 'approver'), ('o1', 'u3', 'approver');
create table ledger (id text primary key);
create table ledger_members (ledger_id text not null, user_id text not null, role text not null, via text);
insert into ledger values ('l1'), ('l2');
insert into ledger_members values
  ('l1', 'u1', 'reviewer', 'staff'), ('l1', 'u2', 'reviewer', 'link'), ('l1', 'u3', 'reviewer', null);
grant select on ledger, ledger_members to authenticated;
`;

const LEDGER_MEMBERS: Readonly<Record<string, string | undefined>> = {
  u1: "staff",
  u2: "link",
  u3: undefined,
};

describe("ownership triggers in generated RLS", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-ownership-"));
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--dialect", "guc", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, sql]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  /** The hint of the error the statements raise by commit, or `null` when they pass. */
  const attempt = async (statements: string): Promise<string | null> => {
    const admin = db!.admin;
    await admin.query("begin");
    try {
      await admin.query(statements);
      await admin.query("set constraints all immediate");
      return null;
    } catch (error) {
      // SAFETY: a Postgres error may carry a hint; String(error) covers any other value
      return (error as { readonly hint?: string }).hint ?? String(error);
    } finally {
      await admin.query("rollback");
    }
  };

  it("caps holders at commit", async () => {
    expect(
      await attempt("insert into org_members values ('o1', 'u4', 'approver')"),
    ).toBe("max-holders");
  });

  it("moves a transfer-only role in one statement or through zero", async () => {
    expect(
      await attempt(
        "update org_members set user_id = 'u4' where org_id = 'o1' and role = 'primary'",
      ),
    ).toBeNull();
    expect(
      await attempt(`
        delete from org_members where org_id = 'o1' and role = 'primary';
        insert into org_members values ('o1', 'u4', 'primary');
      `),
    ).toBeNull();
    expect(
      await attempt("insert into org_members values ('o2', 'u9', 'primary')"),
    ).toBeNull();
  });

  it("moves a transfer-only role between members by demoting first or in one statement", async () => {
    expect(
      await attempt(`
        update org_members set role = 'approver' where org_id = 'o1' and user_id = 'u1';
        update org_members set role = 'primary' where org_id = 'o1' and user_id = 'u2';
      `),
    ).toBeNull();
    expect(
      await attempt(`
        update org_members
        set role = case user_id when 'u1' then 'approver' else 'primary' end
        where org_id = 'o1' and user_id in ('u1', 'u2');
      `),
    ).toBeNull();
    expect(
      await attempt(`
        update org_members set role = 'primary' where org_id = 'o1' and user_id = 'u2';
        update org_members set role = 'approver' where org_id = 'o1' and user_id = 'u1';
      `),
    ).toBe("transfer-only");
  });

  it("refuses a second transfer-only holder and a missing one", async () => {
    expect(
      await attempt("insert into org_members values ('o1', 'u4', 'primary')"),
    ).toBe("transfer-only");
    expect(
      await attempt(
        "delete from org_members where org_id = 'o1' and role = 'primary'",
      ),
    ).toBe("last-holder");
  });

  it("answers permdock_can_assign for the primary only", async () => {
    const can = (user: string, role: string) =>
      db!.as(
        { role: "authenticated", settings: { "app.user_id": user } },
        async () =>
          (
            await db!.tester.query<{ readonly ok: boolean }>(
              "select permdock.permdock_can_assign($1, 'o1') as ok",
              [role],
            )
          ).rows[0]?.ok,
      );
    expect(await can("u1", "approver")).toBe(true);
    expect(await can("u2", "approver")).toBe(false);
    expect(await can("", "approver")).toBe(false);
  });

  it.each(Object.entries(LEDGER_MEMBERS))(
    "agrees with can() on a resource role with for (%s)",
    async (user, via) => {
      const permdock = await createPermDock(policy, {
        id: user,
        memberships: [
          {
            on: { resource: "ledger", id: "l1" },
            roles: ["reviewer"],
            ...(via === undefined ? {} : { via }),
          },
        ],
      });
      const visible = await db!.as(
        { role: "authenticated", settings: { "app.user_id": user } },
        async () =>
          (
            await db!.tester.query<{ readonly id: string }>(
              "select id from ledger order by id",
            )
          ).rows.map((row) => row.id),
      );
      const expected = ["l1", "l2"].filter((id) =>
        permdock.can(permissions.ledger.read, { id }),
      );
      expect(visible).toEqual(expected);
      expect(visible).toEqual(via === "staff" ? ["l1"] : []);
    },
  );
});
