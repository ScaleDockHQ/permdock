import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KeysUser } from "../fixtures/requires-keys/policy.ts";
import type { Postgres } from "./support/postgres.ts";

import {
  nodes,
  permissions,
  policy,
  relations,
  setupSql,
  users,
} from "../fixtures/requires-keys/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/requires-keys");

const KEYS = ["file.read", "file.update", "node.read", "node.update"] as const;

const scopeOf: Readonly<Record<string, string>> = {
  "file.read": permissions.file.read.scope,
  "file.update": permissions.file.update.scope,
  "node.read": permissions.node.read.scope,
  "node.update": permissions.node.update.scope,
};

function subsets(keys: readonly string[]): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [[]];
  for (const key of keys) {
    for (const set of out.slice()) {
      out.push([...set, key]);
    }
  }
  return out;
}

const combinations = subsets(KEYS);

type Seen = {
  readonly read: readonly string[];
  readonly update: readonly string[];
};

async function inDatabase(
  db: Postgres,
  user: string,
  scopes: readonly string[],
): Promise<Seen> {
  return db.as(
    {
      role: "authenticated",
      settings: {
        "request.jwt.claims": JSON.stringify({
          sub: user,
          role: "authenticated",
          api_key: { scopes },
        }),
      },
    },
    async () => {
      const read = (
        await db.tester.query<{ id: string }>(
          "select id from public.node order by id",
        )
      ).rows.map((row) => row.id);
      const update = (
        await db.tester.query<{ id: string }>(
          "update public.node set name = 'changed' returning id",
        )
      ).rows
        .map((row) => row.id)
        .toSorted();
      const rows = (
        await db.tester.query<{ id: string }>(
          "select id from permdock.permitted_node_rows('node.update') id order by id",
        )
      ).rows.map((row) => row.id);
      expect(rows).toEqual(update);
      return { read, update };
    },
  );
}

async function inProcess(
  user: KeysUser,
  scopes: readonly string[],
): Promise<Seen> {
  const permdock = await createPermDock(
    policy,
    {
      principal: { id: user.id, memberships: user.memberships },
      context: {},
      delegation: { scopes: scopes.map((key) => scopeOf[key] ?? key) },
    },
    { relations },
  );
  await permdock.loadRelations(permissions.node.read, nodes);
  await permdock.loadRelations(permissions.node.update, nodes);
  const pick = (
    permission: typeof permissions.node.read | typeof permissions.node.update,
  ) =>
    nodes
      .filter((row) => permdock.can(permission, row))
      .map((row) => row.id)
      .toSorted();
  return {
    read: pick(permissions.node.read),
    update: pick(permissions.node.update),
  };
}

describe("requires under rls.apiKeys: a key covers every required permission, and a write's own", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-requires-keys-"));
  const out = join(dir, "requires-keys.sql");

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

  it("keeps a read-only key out of the write paths its scopes do not name", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const [owner, editor] = users;
    const readOnly = ["file.read"];
    expect(await inDatabase(db, editor?.id ?? "", readOnly)).toEqual({
      read: ["n-edit", "n-view"],
      update: [],
    });
    expect(await inDatabase(db, owner?.id ?? "", readOnly)).toEqual({
      read: ["n-owned"],
      update: [],
    });
    expect(
      await inDatabase(db, owner?.id ?? "", ["file.read", "node.update"]),
    ).toEqual({ read: ["n-owned"], update: [] });
    expect(
      await inDatabase(db, owner?.id ?? "", [
        "file.read",
        "file.update",
        "node.update",
      ]),
    ).toEqual({ read: ["n-owned"], update: ["n-owned"] });
    expect(
      await inDatabase(db, editor?.id ?? "", ["file.read", "node.update"]),
    ).toEqual({ read: ["n-edit", "n-view"], update: ["n-edit"] });
  });

  it("agrees with can() for every user under every combination of scopes", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mismatches: string[] = [];
    for (const scopes of combinations) {
      for (const user of users) {
        const got = await inDatabase(db, user.id, scopes);
        const want = await inProcess(user, scopes);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} [${scopes.join(",")}]: rls ${JSON.stringify(got)} can ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
