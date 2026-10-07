import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RequiresUser } from "../fixtures/requires/policy.ts";
import type { Postgres } from "./support/postgres.ts";

import {
  customRoleSql,
  customRoles,
  drives,
  permissions,
  policy,
  relations,
  setupSql,
  users,
} from "../fixtures/requires/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/requires");

async function visible(db: Postgres, user: string): Promise<readonly string[]> {
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
      (
        await db.tester.query<{ id: string }>(
          "select id from public.drive order by id",
        )
      ).rows.map((row) => row.id),
  );
}

async function inProcess(user: RequiresUser): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, user, {
    relations,
    customRoles,
  });
  await permdock.loadRelations(permissions.drive.read, drives);
  return drives
    .filter((row) => permdock.can(permissions.drive.read, row))
    .map((row) => row.id)
    .toSorted();
}

describe("requires in RLS: a share counts only where the role permission is held", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-requires-"));
  const out = join(dir, "requires.sql");

  beforeAll(async () => {
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    db = await startPostgres([
      setupSql,
      readFileSync(out, "utf8"),
      customRoleSql,
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("shows each user exactly the drives can() allows, custom roles included", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mismatches: string[] = [];
    for (const user of users) {
      const got = await visible(db, user.id);
      const want = await inProcess(user);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches.push(
          `${user.id}: rls [${got.join(",")}] can [${want.join(",")}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    const [member, guest, blocked, reader, globex, none] = users;
    expect(await visible(db, member?.id ?? "")).toEqual(["d-acme"]);
    expect(await visible(db, guest?.id ?? "")).toEqual([]);
    expect(await visible(db, blocked?.id ?? "")).toEqual(["d-globex"]);
    expect(await visible(db, reader?.id ?? "")).toEqual(["d-acme"]);
    expect(await visible(db, globex?.id ?? "")).toEqual(["d-globex"]);
    expect(await visible(db, none?.id ?? "")).toEqual([]);
  });

  it("answers permitted_drive_rows with the same drives, as the caller and for a named user", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const mismatches: string[] = [];
    for (const user of users) {
      const got = await target.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub: user.id,
              role: "authenticated",
            }),
          },
        },
        async () =>
          (
            await target.tester.query<{ id: string }>(
              "select id from permdock.permitted_drive_rows('drive.read') id order by id",
            )
          ).rows.map((row) => row.id),
      );
      const named = (
        await target.admin.query<{ id: string }>(
          "select id from permdock.permitted_drive_rows_for($1, 'drive.read') id order by id",
          [user.id],
        )
      ).rows.map((row) => row.id);
      const want = await inProcess(user);
      for (const [label, list] of [
        ["rows", got],
        ["rows_for", named],
      ] as const) {
        if (JSON.stringify(list) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} ${label} [${list.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("lets a key scoped to the required permission read the drives the share reaches", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const member = users[0]?.id ?? "";
    const withKey = async (scopes: readonly string[]) =>
      target.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub: member,
              role: "authenticated",
              api_key: { scopes },
            }),
          },
        },
        async () =>
          (
            await target.tester.query<{ id: string }>(
              "select id from public.drive order by id",
            )
          ).rows.map((row) => row.id),
      );
    expect(await withKey(["file.read"])).toEqual(["d-acme"]);
    expect(await withKey(["drive.read", "file.read"])).toEqual(["d-acme"]);
    expect(await withKey(["drive.read"])).toEqual([]);
    expect(await withKey(["file.write"])).toEqual([]);
    expect(await withKey([])).toEqual([]);
  });

  it("agrees with can() for every user under each key's scopes", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    const scopeOf: Readonly<Record<string, string>> = {
      "drive.read": permissions.drive.read.scope,
      "file.read": permissions.file.read.scope,
    };
    const mismatches: string[] = [];
    for (const keys of [
      ["drive.read"],
      ["file.read"],
      ["drive.read", "file.read"],
      [],
    ]) {
      for (const user of users) {
        const got = await target.as(
          {
            role: "authenticated",
            settings: {
              "request.jwt.claims": JSON.stringify({
                sub: user.id,
                role: "authenticated",
                api_key: { scopes: keys },
              }),
            },
          },
          async () =>
            (
              await target.tester.query<{ id: string }>(
                "select id from public.drive order by id",
              )
            ).rows.map((row) => row.id),
        );
        const permdock = await createPermDock(
          policy,
          {
            principal: { id: user.id, memberships: user.memberships },
            context: {},
            delegation: { scopes: keys.map((key) => scopeOf[key] ?? key) },
          },
          { relations, customRoles },
        );
        await permdock.loadRelations(permissions.drive.read, drives);
        const want = drives
          .filter((row) => permdock.can(permissions.drive.read, row))
          .map((row) => row.id)
          .toSorted();
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user.id} [${keys.join(",")}]: rls [${got.join(",")}] can [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
