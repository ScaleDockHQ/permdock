import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InheritUser } from "../fixtures/inherit/policy.ts";
import type { Postgres } from "./support/postgres.ts";

import {
  nodes,
  permissions,
  policy,
  relations,
  setupSql,
  users,
} from "../fixtures/inherit/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/inherit");

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
      (await db.tester.query<{ id: string }>(sql)).rows.map((row) => row.id),
  );
}

async function inProcess(
  user: InheritUser,
  permission: typeof permissions.node.read | typeof permissions.node.share,
): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, user, { relations });
  await permdock.loadRelations(permission, nodes);
  return nodes
    .filter((row) => permdock.can(permission, row))
    .map((row) => row.id)
    .toSorted();
}

describe("inherit() in RLS: a node is readable where its drive is", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-inherit-"));
  const out = join(dir, "inherit.sql");

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

  it("shows each user the nodes can() allows, by role and by share", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mismatches: string[] = [];
    for (const user of users) {
      const got = await asUser(
        db,
        user.id,
        "select id from public.node order by id",
      );
      const want = await inProcess(user, permissions.node.read);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches.push(
          `${user.id}: rls [${got.join(",")}] can [${want.join(",")}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    const [member, sharer, globex, none] = users;
    expect(
      await asUser(
        db,
        member?.id ?? "",
        "select id from public.node order by id",
      ),
    ).toEqual(["n-acme", "n-locked", "n-shared"]);
    expect(
      await asUser(
        db,
        sharer?.id ?? "",
        "select id from public.node order by id",
      ),
    ).toEqual(["n-locked", "n-shared"]);
    expect(
      await asUser(
        db,
        globex?.id ?? "",
        "select id from public.node order by id",
      ),
    ).toEqual(["n-globex"]);
    expect(
      await asUser(
        db,
        none?.id ?? "",
        "select id from public.node order by id",
      ),
    ).toEqual([]);
  });

  it("answers permitted_node_rows for a two-link inherit with the grant's own where", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mismatches: string[] = [];
    for (const user of users) {
      const got = await asUser(
        db,
        user.id,
        "select id from permdock.permitted_node_rows('node.share') id order by id",
      );
      const want = await inProcess(user, permissions.node.share);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches.push(
          `${user.id}: rls [${got.join(",")}] can [${want.join(",")}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    expect(
      await asUser(
        db,
        users[1]?.id ?? "",
        "select id from permdock.permitted_node_rows('node.share') id order by id",
      ),
    ).toEqual(["n-acme"]);
  });

  it("answers permitted_node_row for a row value, including one not yet inserted", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const rowValues = nodes
      .map(
        (row) =>
          `('${row.id}', row('${row.id}', '${row.orgId}', '${row.driveId}', '${row.folderId}', ${String(row.locked)}, ${String(row.restricted)})::public.node)`,
      )
      .join(", ");
    const mismatches: string[] = [];
    for (const user of users) {
      for (const key of ["node.read", "node.share"] as const) {
        const got = await asUser(
          db,
          user.id,
          `select v.id from (values ${rowValues}) v(id, r) where permdock.permitted_node_row(v.r, '${key}') order by v.id`,
        );
        const want = await inProcess(
          user,
          key === "node.read" ? permissions.node.read : permissions.node.share,
        );
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} ${key}: rls [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    const member = users[0]?.id ?? "";
    const unsaved =
      "row('n-new', 'acme', 'd-acme', 'f-acme', false, false)::public.node";
    expect(
      await asUser(
        db,
        member,
        `select 'n-new' as id where permdock.permitted_node_row(${unsaved}, 'node.read')`,
      ),
    ).toEqual(["n-new"]);
    expect(
      await asUser(
        db,
        member,
        "select 'n-new' as id where 'n-new' in (select permdock.permitted_node_rows('node.read'))",
      ),
    ).toEqual([]);
    await db.admin.query(
      "grant insert on public.node to authenticated; create policy node_insert on public.node for insert to authenticated with check (permdock.permitted_node_row(node, 'node.read'))",
    );
    expect(
      await asUser(
        db,
        member,
        "insert into public.node values ('n-new', 'acme', 'd-acme', 'f-acme', false, false) returning id",
      ),
    ).toEqual(["n-new"]);
    await expect(
      asUser(
        db,
        users[3]?.id ?? "",
        "insert into public.node values ('n-other', 'acme', 'd-acme', 'f-acme', false, false) returning id",
      ),
    ).rejects.toThrow(/row-level security/u);
  });
});
