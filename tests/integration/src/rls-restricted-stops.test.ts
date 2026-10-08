import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  RestrictedUser,
  TreeName,
} from "../fixtures/restricted-stops/policy.ts";
import type { Postgres } from "./support/postgres.ts";

import {
  policy,
  relations,
  rows,
  setupSql,
  treePermissions,
  trees,
  users,
} from "../fixtures/restricted-stops/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/restricted-stops");

async function asUser(
  db: Postgres,
  user: string,
  sql: string,
): Promise<readonly string[]> {
  return db.as(
    {
      role: "authenticated",
      settings: {
        "request.jwt.claims": JSON.stringify({
          sub: user,
          role: "authenticated",
        }),
      },
    },
    async () =>
      (await db.tester.query<{ id: string }>(sql)).rows
        .map((row) => row.id)
        .toSorted(),
  );
}

async function inProcess(
  user: RestrictedUser,
  tree: TreeName,
  action: "read" | "update",
): Promise<readonly string[]> {
  const permission = treePermissions[tree][action];
  const permdock = await createPermDock(policy, user, { relations });
  await permdock.loadRelations(permission, rows);
  return rows
    .filter((row) => permdock.can(permission, row))
    .map((row) => row.id)
    .toSorted();
}

describe("restricted stops in RLS: the parent walk, the drive link and rows below a restricted one", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-restricted-"));
  const out = join(dir, "restricted.sql");

  beforeAll(async () => {
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    db = await startPostgres([setupSql, readFileSync(out, "utf8")]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const database = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  it("selects the rows can() allows, through the policies and the row helpers", async () => {
    const cases = trees.flatMap((tree) =>
      (["read", "update"] as const).flatMap((action) =>
        users.map((user) => ({ tree, action, user })),
      ),
    );
    const mismatches: string[] = [];
    for (const { tree, action, user } of cases) {
      const want = await inProcess(user, tree, action);
      const helper = await asUser(
        database(),
        user.id,
        `select id from permdock.permitted_${tree}_rows('${tree}.${action}') id`,
      );
      const table =
        action === "read"
          ? await asUser(database(), user.id, `select id from public.${tree}`)
          : helper;
      for (const [label, got] of [
        ["policy", table],
        ["rows", helper],
      ] as const) {
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${tree}.${action} ${user.id} ${label}: rls [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps a restricted row and its subtree off the drive only where the drive link stops", async () => {
    const member = users[3]?.id ?? "";
    const read = (tree: TreeName): Promise<readonly string[]> =>
      asUser(
        database(),
        member,
        `select id from public.${tree} where id in ('secret', 'inner', 'open', 'c32', 'c33')`,
      );
    expect(await read("node")).toEqual([
      "c32",
      "c33",
      "inner",
      "open",
      "secret",
    ]);
    expect(await read("item")).toEqual(["c32", "open"]);
    expect(await read("entry")).toEqual(["c32", "open"]);
  });

  it("follows a move under a restricted row through the closure triggers", async () => {
    const member = users[3]?.id ?? "";
    await database().admin.query(
      `update public.item set "parentId" = 'secret' where id = 'open'`,
    );
    try {
      expect(
        await asUser(
          database(),
          member,
          "select id from public.item where id = 'open'",
        ),
      ).toEqual([]);
    } finally {
      await database().admin.query(
        `update public.item set "parentId" = 'root' where id = 'open'`,
      );
    }
    expect(
      await asUser(
        database(),
        member,
        "select id from public.item where id = 'open'",
      ),
    ).toEqual(["open"]);
  });
});
