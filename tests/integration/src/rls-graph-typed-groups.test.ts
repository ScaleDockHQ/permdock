import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  permissions,
  policy,
  relations,
  rows,
  schemaSql,
  seedSql,
  users,
} from "../fixtures/typed-groups/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/typed-groups");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

async function visible(
  db: Postgres,
  sub: string,
  table: "drive" | "team",
): Promise<readonly string[]> {
  return db.as(
    { role: "authenticated", settings: { "app.user_id": sub } },
    async () =>
      (
        await db.tester.query<{ id: string }>(
          `select id::text from public.${table} order by id::text`,
        )
      ).rows.map((row) => row.id),
  );
}

async function inProcess(
  sub: string,
  table: "drive" | "team",
): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, { id: sub }, { relations });
  if (table === "drive") {
    await permdock.loadRelations(permissions.drive.read, rows.drive);
    return rows.drive
      .filter((row) => permdock.can(permissions.drive.read, row))
      .map((row) => row.id)
      .toSorted();
  }
  await permdock.loadRelations(permissions.team.read, rows.team);
  return rows.team
    .filter((row) => permdock.can(permissions.team.read, row))
    .map((row) => String(row.id))
    .toSorted();
}

describe("edge groups with a typed subject column per group in RLS", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-typed-groups-"));
  const out = join(dir, "typed-groups.sql");

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
    for (const user of users) {
      for (const table of ["drive", "team"] as const) {
        const got = await visible(db, user, table);
        const want = await inProcess(user, table);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user} ${table}: rls [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(await visible(db, "ivy", "drive")).toEqual(["budget"]);
    expect(await visible(db, "ivy", "team")).toEqual(["1", "2", "4"]);
    expect(await visible(db, "dana", "drive")).toEqual(["both", "plans"]);
    expect(await visible(db, "otis", "drive")).toEqual(["both"]);
  });
});
