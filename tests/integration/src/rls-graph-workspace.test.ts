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
const FIXTURE = join(HERE, "../fixtures/workspace");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

type Table = "doc" | "folder" | "team";

const reads = {
  doc: permissions.doc.read,
  folder: permissions.folder.read,
  team: permissions.team.read,
} as const;

async function visible(
  db: Postgres,
  sub: string,
  table: Table,
): Promise<readonly string[]> {
  return db.as(
    { role: "authenticated", settings: { "app.user_id": sub } },
    async () =>
      (
        await db.tester.query<{ id: string }>(
          `select id from public.${table} order by id`,
        )
      ).rows.map((row) => row.id),
  );
}

async function inProcess(
  sub: string,
  table: Table,
): Promise<readonly string[]> {
  const permdock = await createPermDock(
    graphPolicy,
    { id: sub },
    { relations },
  );
  await permdock.loadRelations(reads[table], rows[table]);
  // SAFETY: rows[table] holds the seeded rows for the resource reads[table] checks
  return rows[table]
    .filter((row) => permdock.can(reads[table], row as never))
    .map((row) => row.id)
    .toSorted();
}

describe("relationship graph in RLS: match, includes, groups and link hops", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-workspace-"));
  const out = join(dir, "workspace.sql");

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
      schemaSql,
      readFileSync(out, "utf8"),
      seedSql,
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("shows each subject exactly the rows can() allows", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mismatches: string[] = [];
    for (const user of users.filter((item) => item.memberships === undefined)) {
      for (const table of ["doc", "folder", "team"] as const) {
        const got = await visible(db, user.id, table);
        const want = await inProcess(user.id, table);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} ${table}: rls [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(await visible(db, "otto", "team")).toEqual([
      "eng-team",
      "oncall",
      "sre",
    ]);
    expect(await visible(db, "lena", "doc")).toEqual(["deep-doc"]);
    expect(await visible(db, "rob", "doc")).toEqual([]);
  });
});
