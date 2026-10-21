import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import * as merged from "../fixtures/merged-resource/merged/policy.ts";
import { rows, setupSql, users } from "../fixtures/merged-resource/shared.ts";
import * as split from "../fixtures/merged-resource/split/policy.ts";
import { startPostgres } from "./support/postgres.ts";
import { jwtClaims, readableIds } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../fixtures/merged-resource");

const VERBS = ["read", "update", "comment"] as const;
type Verb = (typeof VERBS)[number];

/** The split keys whose union the merged `file.<verb>` must reach. */
const SPLIT_KEYS: Readonly<Record<Verb, readonly string[]>> = {
  read: ["file.read", "fileNode.read"],
  update: ["file.update"],
  comment: ["fileNode.comment"],
};

const SPLIT_LEAVES = {
  read: [split.permissions.file.read, split.permissions.fileNode.read],
  update: [split.permissions.file.update],
  comment: [split.permissions.fileNode.comment],
} as const;

const helperOf = (key: string): string =>
  key.startsWith("fileNode.")
    ? "permitted_file_node_rows"
    : "permitted_file_rows";

async function generate(name: string, dir: string): Promise<string> {
  const out = join(dir, `${name}.sql`);
  const result = await run(
    ["rls", "generate", "--target", "sql", "--out", out],
    { cwd: join(FIXTURES, name) },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate ${name}: ${result.stdout}${result.stderr}`);
  }
  return readFileSync(out, "utf8");
}

async function idsAs(
  db: Postgres,
  user: string,
  sql: string,
): Promise<readonly string[]> {
  return db.as({ role: "authenticated", settings: jwtClaims(user) }, async () =>
    (await db.tester.query<{ id: string }>(sql)).rows
      .map((row) => row.id)
      .toSorted(),
  );
}

const union = (lists: readonly (readonly string[])[]): readonly string[] =>
  [...new Set(lists.flat())].toSorted();

describe("merging an org-level and a per-row resource over one table", () => {
  let before: Postgres | undefined;
  let after: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-merged-"));

  beforeAll(async () => {
    const [splitSql, mergedSql] = await Promise.all([
      generate("split", dir),
      generate("merged", dir),
    ]);
    [before, after] = await Promise.all([
      startPostgres([setupSql, splitSql]),
      startPostgres([setupSql, mergedSql]),
    ]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([before?.stop(), after?.stop()]);
  });

  const databases = (): { split: Postgres; merged: Postgres } => {
    if (before === undefined || after === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return { split: before, merged: after };
  };

  it("reaches the union of the two old keys, per user and verb, in SQL and in process", async () => {
    const db = databases();
    const mismatches: string[] = [];
    for (const user of users) {
      const splitDock = await getPermDock(split.policy, user, {
        relations: split.relations,
      });
      const mergedDock = await getPermDock(merged.policy, user, {
        relations: merged.relations,
      });
      for (const verb of VERBS) {
        const oldSql = await Promise.all(
          SPLIT_KEYS[verb].map((key) =>
            idsAs(
              db.split,
              user.id,
              `select id from permdock.${helperOf(key)}('${key}') id`,
            ),
          ),
        );
        const want = union(oldSql);
        const oldInProcess = union(
          await Promise.all(
            SPLIT_LEAVES[verb].map((leaf) =>
              readableIds(splitDock, leaf, rows),
            ),
          ),
        );
        const newSql = await idsAs(
          db.merged,
          user.id,
          `select id from permdock.permitted_file_rows('file.${verb}') id`,
        );
        const newInProcess = await readableIds(
          mergedDock,
          merged.permissions.file[verb],
          rows,
        );
        for (const [label, got] of [
          ["split in process", oldInProcess],
          ["merged rows", newSql],
          ["merged in process", newInProcess],
        ] as const) {
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(
              `${verb} ${user.id} ${label}: [${got.join(",")}], split rows [${want.join(",")}]`,
            );
          }
        }
      }
    }
    expect(mismatches).toStrictEqual([]);
  });

  it("keeps the org-wide role branch and the per-row relation branches apart", async () => {
    const db = databases();
    const read = (index: number): Promise<readonly string[]> =>
      idsAs(
        db.merged,
        users[index]?.id ?? "",
        "select id from permdock.permitted_file_rows('file.read') id",
      );
    expect(await read(1)).toStrictEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(await read(2)).toStrictEqual(["o2", "r1"]);
    expect(await read(3)).toStrictEqual(["r3", "r4", "r5"]);
    expect(await read(4)).toStrictEqual(["o1", "o2", "r1", "r2"]);
  });

  it("selects the same rows from the table under both policy sets", async () => {
    const db = databases();
    for (const user of users) {
      const query = "select id from public.file_nodes";
      expect(await idsAs(db.merged, user.id, query)).toStrictEqual(
        await idsAs(db.split, user.id, query),
      );
    }
  });

  it("seeds role_permissions under the renamed keys too", async () => {
    const seeded = await databases().merged.admin.query<{ permission: string }>(
      "select distinct permission from permdock.role_permissions where permission like 'file%' order by 1",
    );
    expect(seeded.rows.map((row) => row.permission)).toStrictEqual([
      "file.read",
      "file.update",
      "fileNode.read",
    ]);
  });
});
