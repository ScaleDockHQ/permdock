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
  "../fixtures/ownership-sources",
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
create table memberships (
  user_id text not null,
  scope text not null,
  scope_id text not null,
  role text not null,
  expires_at timestamptz
);
create table org_approvers (org_id text not null, user_id text not null);
create table payment (id text primary key, org_id text not null);
create table ledger (id text primary key);
create table ledger_members (ledger_id text not null, user_id text not null, role text not null, via text);
insert into memberships values
  ('u1', 'org', 'o1', 'primary', null),
  ('u2', 'org', 'o1', 'approver', null),
  ('u5', 'org', 'o1', 'approver', now() - interval '1 day'),
  ('u6', 'project', 'o1', 'approver', null);
insert into org_approvers values ('o1', 'u3');
`;

describe("ownership triggers over membership sources", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-ownership-sources-"));
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

  it("counts live holders across every source of the scope", async () => {
    expect(await attempt("insert into org_approvers values ('o1', 'u4')")).toBe(
      "max-holders",
    );
    expect(
      await attempt(
        "insert into memberships values ('u4', 'org', 'o1', 'approver', null)",
      ),
    ).toBe("max-holders");
    expect(
      await attempt(
        "insert into memberships values ('u4', 'org', 'o1', 'approver', now() - interval '1 hour')",
      ),
    ).toBeNull();
    expect(
      await attempt(
        "insert into memberships values ('u4', 'project', 'o1', 'approver', null)",
      ),
    ).toBeNull();
  });

  it("keeps the last holder and lets an emptied instance go", async () => {
    expect(
      await attempt(
        "delete from memberships where scope = 'org' and role = 'primary'",
      ),
    ).toBe("last-holder");
    expect(
      await attempt(
        "update memberships set expires_at = now() - interval '1 hour' where role = 'primary'",
      ),
    ).toBe("last-holder");
    expect(
      await attempt(`
        delete from memberships where scope = 'org' and scope_id = 'o1';
        delete from org_approvers where org_id = 'o1';
      `),
    ).toBeNull();
  });

  it("moves a transfer-only role in one statement or through zero", async () => {
    expect(
      await attempt(
        "update memberships set user_id = 'u4' where scope = 'org' and role = 'primary'",
      ),
    ).toBeNull();
    expect(
      await attempt(`
        update memberships set role = 'approver' where scope = 'org' and user_id = 'u1';
        update memberships set role = 'primary' where scope = 'org' and user_id = 'u2';
      `),
    ).toBeNull();
    expect(
      await attempt(`
        update memberships set role = 'primary' where scope = 'org' and user_id = 'u2';
        update memberships set role = 'approver' where scope = 'org' and user_id = 'u1';
      `),
    ).toBe("transfer-only");
    expect(
      await attempt(
        "insert into memberships values ('u9', 'org', 'o2', 'primary', null)",
      ),
    ).toBeNull();
  });
});
