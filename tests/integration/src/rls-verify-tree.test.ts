import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { saasSchemaSql, saasSeed, saasSeedSql } from "permdock/testing/saas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/saas");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

const GRANTS = `
grant select, insert on all tables in schema public to authenticated;
`;

const CONSTRAINED = `
create type folder_state as enum ('active', 'archived');
alter table folder add column kind text not null default 'folder' check (kind in ('folder', 'drive'));
alter table folder alter column kind drop default;
alter table folder add column state folder_state not null default 'active';
alter table folder alter column state drop default;
alter table folder add column region text not null default 'eu' check (region = 'eu');
alter table folder alter column region drop default;
`;

describe("rls verify --tree over the shared SaaS folder tree", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-saas-tree-"));
  const out = join(dir, "saas.sql");

  beforeAll(async () => {
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    db = await startPostgres([
      ROLES,
      saasSchemaSql,
      saasSeedSql(),
      readFileSync(out, "utf8"),
      GRANTS,
      CONSTRAINED,
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("agrees with decide on a generated tree with restricted branches, shares and an expired share", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const result = await run(["rls", "verify", "--tree", "--db", db.uri], {
      cwd: FIXTURE,
    });
    const counts =
      /verified (\d+) tree check\(s\) against the database \((\d+) granted\)/u.exec(
        result.stdout,
      );
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: expect.stringMatching(/verified/u),
    });
    expect(result.stdout).not.toMatch(
      /in-process|database (allowed|filtered)/u,
    );
    expect(Number(counts?.[1])).toBeGreaterThan(50);
    expect(Number(counts?.[2])).toBeGreaterThan(0);
  });

  it("rolls the generated tree back", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const folders = await db.admin.query<{ count: string }>(
      "select count(*) from folder",
    );
    expect(Number(folders.rows[0]?.count)).toBe(saasSeed.folders.length);
  });
});
