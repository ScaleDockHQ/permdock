import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/role-sources",
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
create table org_roles (id int primary key, key text not null unique);
insert into org_roles values (1, 'primary'), (2, 'approver'), (3, 'reviewer');
create table org_members (org_id text not null, user_id text not null, tier text, role_id int references org_roles (id));
create table payment (id text primary key, org_id text not null);
insert into org_members values ('o1', 'u1', null, 1), ('o1', 'u2', 'approver', null), ('o1', 'u3', 'approver', 2);
create table ledger (id text primary key);
create table ledger_members (ledger_id text not null, user_id text not null, tier text, role_id int references org_roles (id), via text);
insert into ledger values ('l1'), ('l2');
insert into ledger_members values ('l1', 'u1', 'reviewer', null, 'staff'), ('l2', 'u1', null, 3, 'staff'), ('l1', 'u2', null, null, 'staff');
grant select on ledger, ledger_members, org_roles to authenticated;
`;

describe("membership rows with several role sources", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-role-sources-"));
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

  it("counts a holder once across its sources", async () => {
    expect(
      await attempt(
        "insert into org_members values ('o1', 'u4', 'approver', null)",
      ),
    ).toBe("max-holders");
    expect(
      await attempt(
        "update org_members set tier = 'approver' where user_id = 'u1'",
      ),
    ).toBe("max-holders");
    expect(
      await attempt(
        "update org_members set role_id = null where user_id = 'u3'",
      ),
    ).toBeNull();
    expect(
      await attempt(
        "update org_members set role_id = null where user_id = 'u1'",
      ),
    ).toBe("last-holder");
  });

  it("keeps a transfer-only key to one move per statement in either source", async () => {
    expect(
      await attempt(
        "update org_members set user_id = 'u4' where org_id = 'o1' and role_id = 1",
      ),
    ).toBeNull();
    expect(
      await attempt(
        "insert into org_members values ('o1', 'u4', 'primary', null)",
      ),
    ).toBe("transfer-only");
  });

  it("answers permdock_can_assign and the helpers from every source", async () => {
    const ask = <T>(user: string, sql: string, values: unknown[]) =>
      db!.as(
        { role: "authenticated", settings: { "app.user_id": user } },
        async () =>
          (await db!.tester.query<{ ok: T }>(sql, values)).rows[0]?.ok,
      );
    const can = (user: string, role: string) =>
      ask<boolean>(
        user,
        "select permdock.permdock_can_assign($1, 'o1') as ok",
        [role],
      );
    expect(await can("u1", "approver")).toBe(true);
    expect(await can("u2", "approver")).toBe(false);
    const permitted = (user: string, key: string) =>
      ask<string[]>(
        user,
        "select array(select permdock.permitted_org_ids($1)) as ok",
        [key],
      );
    expect(await permitted("u1", "payment.approve")).toEqual(["o1"]);
    expect(await permitted("u2", "payment.read")).toEqual(["o1"]);
    expect(await permitted("u3", "payment.read")).toEqual(["o1"]);
    expect(await permitted("u2", "payment.approve")).toEqual([]);
  });

  it("compiles a resource membership condition over every source", async () => {
    const visible = (user: string) =>
      db!.as(
        { role: "authenticated", settings: { "app.user_id": user } },
        async () =>
          (
            await db!.tester.query<{ readonly id: string }>(
              "select id from ledger order by id",
            )
          ).rows.map((row) => row.id),
      );
    expect(await visible("u1")).toEqual(["l1", "l2"]);
    expect(await visible("u2")).toEqual([]);
  });
});
