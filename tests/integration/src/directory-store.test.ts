import type { DirectoryStore, ScimFilter, SqlQuery } from "permdock/scim";

import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "permdock/cli";
import {
  DirectoryUniquenessError,
  directoryMembershipSource,
  memoryDirectoryStore,
  postgresDirectoryStore,
} from "permdock/scim";
import { testDirectoryStore } from "permdock/testing";
import { beforeAll, describe, expect, it } from "vitest";

async function generated(dialect: "guc" | "supabase"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-scim-generate-"));
  try {
    const result = await run(
      ["scim", "generate", "--dialect", dialect, "--out", "-"],
      { cwd },
    );
    if (result.code !== 0) {
      throw new Error(`scim generate: ${result.stdout}`);
    }
    return result.stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const SQL = await generated("guc");

function queryOf(db: PGlite): SqlQuery {
  return (text, values) => db.query(text, [...values]);
}

async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SQL);
  return db;
}

async function freshStore(): Promise<DirectoryStore> {
  return postgresDirectoryStore(queryOf(await freshDatabase()));
}

const conformance = await freshStore();

describe("postgresDirectoryStore conformance", () => {
  testDirectoryStore(conformance, { tenants: ["acme", "globex"] });
});

/** The same writes against both stores, so reads can be compared. */
async function seed(store: DirectoryStore): Promise<void> {
  const users = [
    { id: "u1", userName: "ada@acme.test", externalId: "ada", active: true },
    { id: "u2", userName: "bea@acme.test", active: false },
    { id: "u3", userName: "cy@other.test", externalId: "cy", active: true },
  ];
  for (const user of users) {
    await store.putUser("acme", {
      ...user,
      meta: { created: "", lastModified: "" },
    });
  }
  await store.putGroup("acme", {
    id: "g1",
    displayName: "Engineering",
    members: [{ value: "u1" }, { value: "u3" }],
    roles: ["member"],
    meta: { created: "", lastModified: "" },
  });
  await store.putGroup("acme", {
    id: "g2",
    displayName: "Empty",
    members: [],
    meta: { created: "", lastModified: "" },
  });
}

const userFilters: readonly ScimFilter[] = [
  { op: "eq", attribute: "userName", value: "ada@acme.test" },
  { op: "ne", attribute: "externalId", value: "ada" },
  { op: "co", attribute: "userName", value: "@acme" },
  { op: "sw", attribute: "userName", value: "b" },
  { op: "pr", attribute: "externalId" },
  { op: "eq", attribute: "active", value: false },
  { op: "eq", attribute: "active", value: "TRUE" },
  { op: "co", attribute: "active", value: "tr" },
  { op: "eq", attribute: "userName", value: `x' or '1'='1` },
  {
    op: "or",
    filters: [
      { op: "eq", attribute: "id", value: "u2" },
      {
        op: "and",
        filters: [
          { op: "pr", attribute: "externalId" },
          { op: "sw", attribute: "userName", value: "cy" },
        ],
      },
    ],
  },
];

const groupFilters: readonly ScimFilter[] = [
  { op: "eq", attribute: "members.value", value: "u3" },
  { op: "ne", attribute: "members.value", value: "u1" },
  { op: "pr", attribute: "members.value" },
  { op: "sw", attribute: "displayName", value: "Eng" },
  { op: "pr", attribute: "externalId" },
];

describe("postgresDirectoryStore parity with memoryDirectoryStore", () => {
  const memory = memoryDirectoryStore();
  let pg: DirectoryStore;

  beforeAll(async () => {
    pg = await freshStore();
    await seed(memory);
    await seed(pg);
  });

  it.each(userFilters.map((filter) => [JSON.stringify(filter), filter]))(
    "users %s",
    async (_name, filter) => {
      const ids = async (store: DirectoryStore) =>
        (await store.findUsers("acme", filter, {})).Resources.map(
          (user) => user.id,
        );
      expect(await ids(pg)).toStrictEqual(await ids(memory));
    },
  );

  it.each(groupFilters.map((filter) => [JSON.stringify(filter), filter]))(
    "groups %s",
    async (_name, filter) => {
      const ids = async (store: DirectoryStore) =>
        (await store.findGroups("acme", filter, {})).Resources.map(
          (group) => group.id,
        );
      expect(await ids(pg)).toStrictEqual(await ids(memory));
    },
  );

  it("pages by cursor and by startIndex the same way", async () => {
    for (const page of [
      { count: 2 },
      { count: 2, cursor: "2" },
      { startIndex: 2, count: 1 },
      { count: 5, cursor: "9" },
    ]) {
      const [left, right] = await Promise.all([
        pg.findUsers("acme", undefined, page),
        memory.findUsers("acme", undefined, page),
      ]);
      expect({
        ...left,
        Resources: left.Resources.map((user) => user.id),
      }).toStrictEqual({
        ...right,
        Resources: right.Resources.map((user) => user.id),
      });
    }
  });

  it("keeps userName and externalId unique per tenant only", async () => {
    const duplicate = {
      id: "u9",
      userName: "ada@acme.test",
      active: true,
      meta: { created: "", lastModified: "" },
    };
    await expect(pg.putUser("acme", duplicate)).rejects.toMatchObject({
      name: "DirectoryUniquenessError",
      message: "userName",
    });
    await expect(
      pg.putUser("acme", {
        ...duplicate,
        userName: "new@acme.test",
        externalId: "ada",
      }),
    ).rejects.toMatchObject({ message: "externalId" });
    await expect(pg.putUser("globex", duplicate)).resolves.toMatchObject({
      id: "u9",
    });
    await expect(
      pg.patchUser("acme", "u2", [
        { op: "replace", path: "userName", value: "ada@acme.test" },
      ]),
    ).rejects.toBeInstanceOf(DirectoryUniquenessError);
  });

  it("applies member patches like the memory store", async () => {
    const ops = [
      { op: "add" as const, path: "members", value: [{ value: "u2" }] },
      { op: "remove" as const, path: "members", value: [{ value: "u1" }] },
      { op: "replace" as const, path: "roles", value: ["admin", 7] },
    ];
    const [left, right] = await Promise.all([
      pg.patchGroup("acme", "g1", ops),
      memory.patchGroup("acme", "g1", ops),
    ]);
    expect(left.members).toStrictEqual(right.members);
    expect(left.roles).toStrictEqual(right.roles);
    expect(left.meta.created <= left.meta.lastModified).toBe(true);
    expect((await pg.getGroup("acme", "g1"))?.members).toStrictEqual(
      right.members,
    );
  });

  it("drops a deleted user from every group and keeps created times", async () => {
    const before = await pg.getUser("acme", "u3");
    await pg.putUser("acme", {
      id: "u3",
      userName: "cy@other.test",
      externalId: "cy",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    expect((await pg.getUser("acme", "u3"))?.meta.created).toBe(
      before?.meta.created,
    );
    await pg.deleteUser("acme", "u3");
    await memory.deleteUser("acme", "u3");
    expect(await pg.groupsFor("acme", "u3")).toStrictEqual([]);
    expect((await pg.getGroup("acme", "g1"))?.members).toStrictEqual(
      (await memory.getGroup("acme", "g1"))?.members,
    );
    await expect(pg.deleteUser("acme", "u3")).rejects.toMatchObject({
      name: "DirectoryNotFoundError",
    });
    await expect(pg.deleteGroup("acme", "missing")).rejects.toMatchObject({
      name: "DirectoryNotFoundError",
    });
  });
});

describe("postgresDirectoryStore under concurrent writes", () => {
  it("re-applies a PATCH when another write lands between its read and its write", async () => {
    const db = await freshDatabase();
    const base = queryOf(db);
    const other = postgresDirectoryStore(base);
    let raced = false;
    const racing: SqlQuery = async (text, values) => {
      if (!raced && text.includes("t.revision = $7")) {
        raced = true;
        await other.patchGroup("acme", "g1", [
          { op: "add", path: "members", value: [{ value: "u_other" }] },
        ]);
      }
      return base(text, values);
    };
    const store = postgresDirectoryStore(racing);
    await store.putGroup("acme", {
      id: "g1",
      displayName: "Editors",
      members: [{ value: "u_first" }],
      meta: { created: "", lastModified: "" },
    });
    const patched = await store.patchGroup("acme", "g1", [
      { op: "add", path: "members", value: [{ value: "u_mine" }] },
    ]);
    expect(raced).toBe(true);
    expect(patched.members.map((member) => member.value)).toStrictEqual([
      "u_first",
      "u_other",
      "u_mine",
    ]);
  });
});

describe("scim generate on Supabase", () => {
  it("keeps the directory away from anon and authenticated", async () => {
    const db = new PGlite();
    await db.exec(
      "create role anon nologin; create role authenticated nologin;",
    );
    await db.exec(await generated("supabase"));
    const store = postgresDirectoryStore(queryOf(db));
    await store.putGroup("acme", {
      id: "g1",
      displayName: "Editors",
      members: [{ value: "u1" }],
      roles: ["editor"],
      meta: { created: "", lastModified: "" },
    });
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`begin; set local role ${role};`);
      try {
        await expect(
          db.query("select * from permdock.scim_groups"),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        await db.exec("rollback");
      }
    }
    expect(
      (await db.query("select * from permdock.scim_groups")).rows,
    ).toHaveLength(1);
  });

  it("feeds directoryMembershipSource from the tables", async () => {
    const store = await freshStore();
    const user = await store.putUser("acme", {
      id: "",
      userName: "ada@acme.test",
      externalId: "00u1",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    await store.putGroup("acme", {
      id: "g_editors",
      displayName: "Editors",
      members: [{ value: user.id }],
      roles: ["editor"],
      meta: { created: "", lastModified: "" },
    });
    const source = directoryMembershipSource(store);
    expect(
      await source.membershipsFor({ id: "00u1" }, { tenant: "acme" }),
    ).toStrictEqual([
      {
        tenant: "acme",
        roles: ["editor"],
        via: "group:g_editors",
        managedBy: "idp",
      },
    ]);
    expect(
      await source.membershipsFor({ id: "00u1" }, { tenant: "globex" }),
    ).toStrictEqual([]);
  });
});
