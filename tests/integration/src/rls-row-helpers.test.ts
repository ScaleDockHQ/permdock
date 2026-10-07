import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  graphPolicy,
  permissions,
  relations,
  rows,
  schemaSql,
  seedSql,
  users,
} from "../fixtures/workspace/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/workspace-rows");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

const checks = [
  ["doc", permissions.doc.read],
  ["doc", permissions.doc.review],
  ["folder", permissions.folder.read],
  ["team", permissions.team.read],
] as const;

async function inProcess(
  sub: string,
  table: "doc" | "folder" | "team",
  permission: (typeof checks)[number][1],
): Promise<readonly string[]> {
  const permdock = await createPermDock(
    graphPolicy,
    { id: sub },
    { relations },
  );
  await permdock.loadRelations(permission, rows[table]);
  // SAFETY: rows[table] holds the seeded rows of the resource the permission names
  return rows[table]
    .filter((row) => permdock.can(permission, row as never))
    .map((row) => row.id)
    .toSorted();
}

describe("permitted_<resource>_rows with helpersOnly: the graph without hand-written policies", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-row-helpers-"));
  const out = join(dir, "rows.sql");
  let sql = "";

  beforeAll(async () => {
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    sql = readFileSync(out, "utf8");
    db = await startPostgres([ROLES, schemaSql, sql, seedSql]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("writes the row helpers and no table policy", () => {
    expect(sql).toContain('"permdock".permitted_doc_rows(p_permission text)');
    expect(sql).toContain(
      '"permdock".permitted_doc_rows_for(p_user text, p_permission text, p_claims jsonb',
    );
    expect(sql).not.toMatch(/create policy \S+ on "public"/u);
  });

  it("answers each permission with exactly the rows can() allows, for the caller and for a named user", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const mismatches: string[] = [];
    for (const user of users.filter((item) => item.memberships === undefined)) {
      for (const [table, permission] of checks) {
        const got = await target.as(
          { role: "authenticated", settings: { "app.user_id": user.id } },
          async () =>
            (
              await target.tester.query<{ id: string }>(
                "select id from permdock.permitted_" +
                  table +
                  "_rows($1) id order by id",
                [permission.key],
              )
            ).rows.map((row) => row.id),
        );
        const named = (
          await target.admin.query<{ id: string }>(
            "select id from permdock.permitted_" +
              table +
              "_rows_for($1, $2) id order by id",
            [user.id, permission.key],
          )
        ).rows.map((row) => row.id);
        const want = await inProcess(user.id, table, permission);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} ${permission.key}: rows [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
        if (JSON.stringify(named) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} ${permission.key}: rows_for [${named.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    const lena = await target.admin.query<{ id: string }>(
      "select id from permdock.permitted_doc_rows_for('lena', 'doc.review') id",
    );
    expect(lena.rows.map((row) => row.id)).toEqual(["deep-doc"]);
    const setting = await target.admin.query<{ value: string | null }>(
      "select current_setting('app.user_id', true) as value",
    );
    expect(setting.rows[0]?.value ?? "").toBe("");
  });

  it("answers nothing for a permission of another resource or an unknown key", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const got = await target.as(
      { role: "authenticated", settings: { "app.user_id": "vera" } },
      async () =>
        (
          await target.tester.query<{ id: string }>(
            "select id from permdock.permitted_doc_rows('folder.read') id union all select id from permdock.permitted_doc_rows('doc.nope') id",
          )
        ).rows,
    );
    expect(got).toEqual([]);
  });
});
