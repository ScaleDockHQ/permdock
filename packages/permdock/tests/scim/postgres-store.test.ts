import { describe, expect, it } from "vitest";

import type { SqlQuery } from "../../src/core/sql.ts";

import {
  isDirectoryNotFoundError,
  isDirectoryUniquenessError,
  postgresDirectoryStore,
} from "../../src/scim/index.ts";

type Call = { readonly text: string; readonly values: readonly unknown[] };

function recorder(answer: (call: Call) => Awaited<ReturnType<SqlQuery>>): {
  readonly query: SqlQuery;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    query: (text, values) => {
      const call = { text, values };
      calls.push(call);
      try {
        return Promise.resolve(answer(call));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
}

const user = {
  id: "u1",
  userName: "ada",
  externalId: "00u1",
  active: true,
  created: "2026-10-21T09:00:00.000Z",
  lastModified: "2026-10-21T09:00:00.000Z",
  revision: 1,
};

describe("postgresDirectoryStore", () => {
  it("binds filter values as parameters and never splices them into the SQL", async () => {
    const { query, calls } = recorder(() => [{ total: 0, resources: "[]" }]);
    const store = postgresDirectoryStore(query);
    const hostile = `x' or '1'='1`;
    await store.findUsers(
      "acme",
      { op: "eq", attribute: "userName", value: hostile },
      { startIndex: 1, count: 1 },
    );
    expect(calls[0]?.text).not.toContain(hostile);
    expect(calls[0]?.values).toEqual(["acme", hostile]);
    expect(calls[0]?.text).toContain('"permdock"."scim_users"');
  });

  it("reads rows whether the driver returns { rows } or the rows, and JSON as text", async () => {
    const { query } = recorder(() => ({
      rows: [
        {
          resource: JSON.stringify({ ...user, emails: null, x: { cost: "7" } }),
        },
      ],
    }));
    const found = await postgresDirectoryStore(query).getUser("acme", "u1");
    expect(found).toEqual({
      id: "u1",
      userName: "ada",
      externalId: "00u1",
      active: true,
      x: { cost: "7" },
      meta: {
        created: user.created,
        lastModified: user.lastModified,
        resourceType: "User",
      },
    });
  });

  it("maps a unique violation to DirectoryUniquenessError by constraint", async () => {
    const violation = (constraint: string) =>
      postgresDirectoryStore(
        recorder(() => {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint,
          });
        }).query,
      ).putUser("acme", {
        id: "u1",
        userName: "ada",
        active: true,
        meta: { created: "", lastModified: "" },
      });
    await expect(violation("scim_users_user_name_key")).rejects.toSatisfy(
      (error: unknown) =>
        isDirectoryUniquenessError(error) && error.message === "userName",
    );
    await expect(violation("scim_users_external_id_key")).rejects.toSatisfy(
      (error: unknown) =>
        isDirectoryUniquenessError(error) && error.message === "externalId",
    );
  });

  it("rethrows any other database error", async () => {
    const store = postgresDirectoryStore(
      recorder(() => {
        throw Object.assign(new Error("connection lost"), { code: "08006" });
      }).query,
    );
    await expect(store.getGroup("acme", "g1")).rejects.toThrow(
      "connection lost",
    );
  });

  it("answers not found for a missing user on PATCH and DELETE", async () => {
    const store = postgresDirectoryStore(
      recorder((call) =>
        call.text.includes("count(*)::integer as deleted")
          ? [{ deleted: 0 }]
          : [],
      ).query,
    );
    await expect(
      store.patchUser("acme", "missing", [
        { op: "replace", path: "active", value: false },
      ]),
    ).rejects.toSatisfy(isDirectoryNotFoundError);
    await expect(store.deleteUser("acme", "missing")).rejects.toSatisfy(
      isDirectoryNotFoundError,
    );
  });

  it("gives up on a PATCH whose row keeps changing", async () => {
    const { query, calls } = recorder((call) =>
      call.text.startsWith("update") ? [] : [{ resource: user }],
    );
    await expect(
      postgresDirectoryStore(query).patchUser("acme", "u1", [
        { op: "replace", path: "active", value: false },
      ]),
    ).rejects.toThrow(/kept changing/u);
    expect(calls.filter((call) => call.text.startsWith("update"))).toHaveLength(
      8,
    );
  });

  it("writes each member once, in order, with the group", async () => {
    const { query, calls } = recorder(() => [
      {
        resource: {
          id: "g1",
          displayName: "Editors",
          members: ["u1", "u2"],
          roles: ["editor"],
          created: user.created,
          lastModified: user.lastModified,
          revision: 1,
        },
      },
    ]);
    const group = await postgresDirectoryStore(query, {
      schema: "identity",
    }).putGroup("acme", {
      id: "g1",
      displayName: "Editors",
      members: [{ value: "u1" }, { value: "u2" }, { value: "u1" }],
      roles: ["editor"],
      meta: { created: "", lastModified: "" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('"identity"."scim_group_members"');
    expect(calls[0]?.values.at(-1)).toEqual(["u1", "u2"]);
    expect(group.members).toEqual([{ value: "u1" }, { value: "u2" }]);
  });

  it("compiles every filter shape with bound values", async () => {
    const { query, calls } = recorder(() => [{ total: 0, resources: [] }]);
    const store = postgresDirectoryStore(query);
    await store.findUsers(
      "acme",
      {
        op: "or",
        filters: [
          {
            op: "and",
            filters: [
              { op: "eq", attribute: "active", value: true },
              { op: "ne", attribute: "externalId", value: "x" },
            ],
          },
          { op: "co", attribute: "userName", value: "ad" },
          { op: "sw", attribute: "userName", value: "a" },
          { op: "co", attribute: "active", value: "tr" },
          { op: "pr", attribute: "externalId" },
          { op: "eq", attribute: "nickName", value: "x" },
          { op: "ne", attribute: "nickName", value: "x" },
          { op: "eq", attribute: "members.value", value: "u1" },
          { op: "ne", attribute: "members.value", value: "u1" },
        ],
      },
      {},
    );
    const users = calls[0];
    expect(users?.text).toContain(
      "(lower(u.active::text) = $2 and u.external_id is distinct from $3)",
    );
    expect(users?.text).toContain("strpos(u.user_name, $4) > 0");
    expect(users?.text).toContain("starts_with(u.user_name, $5)");
    expect(users?.text).toContain("coalesce(u.external_id, '') <> ''");
    expect(users?.text).toContain(
      "starts_with(u.user_name, $5) or false or coalesce(u.external_id, '') <> '' or false or true or false or true)",
    );
    expect(users?.values).toEqual(["acme", "true", "x", "ad", "a"]);

    await store.findGroups(
      "acme",
      {
        op: "and",
        filters: [
          { op: "pr", attribute: "members.value" },
          { op: "eq", attribute: "members.value", value: "u1" },
        ],
      },
      {},
    );
    expect(calls[1]?.text).toContain("m.group_id = g.id and true) and exists");
    expect(calls[1]?.text).toContain("m.user_id = $2");
    expect(calls[1]?.values).toEqual(["acme", "u1"]);
  });

  it("pages by cursor or startIndex and answers the next cursor", async () => {
    const { query, calls } = recorder(() => [
      { total: 3, resources: [{ ...user, emails: [] }] },
    ]);
    const store = postgresDirectoryStore(query);
    const byCursor = await store.findUsers("acme", undefined, {
      cursor: "1",
      count: 1,
    });
    expect(calls[0]?.text).toContain("offset 1 limit 1");
    expect(byCursor).toMatchObject({
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
      nextCursor: "2",
    });
    await store.findUsers("acme", undefined, { cursor: "junk", count: 1 });
    expect(calls[1]?.text).toContain("offset 0 limit 1");
    await store.findUsers("acme", undefined, { startIndex: 3, count: 1 });
    expect(calls[2]?.text).toContain("offset 2 limit 1");
    const empty = postgresDirectoryStore(recorder(() => []).query);
    await expect(
      empty.findGroups("acme", undefined, {}),
    ).resolves.toMatchObject({ totalResults: 0, Resources: [] });
  });

  it("refuses a malformed row", async () => {
    const store = postgresDirectoryStore(
      recorder(() => [{ resource: "null" }]).query,
    );
    await expect(store.getUser("acme", "u1")).rejects.toThrow(
      /malformed user/u,
    );
    await expect(store.getGroup("acme", "g1")).rejects.toThrow(
      /malformed group/u,
    );
  });

  it("generates an id and keeps an IdP-sent created time", async () => {
    const { query, calls } = recorder(() => [{ resource: user }]);
    await postgresDirectoryStore(query).putUser("acme", {
      id: "",
      userName: "ada",
      active: true,
      meta: { created: user.created, lastModified: "" },
    });
    expect(calls[0]?.values[1]).toMatch(/^u_[0-9a-f]{16}$/u);
    expect(calls[0]?.values[7]).toBe(user.created);
  });

  it("patches a user and a group against the revision it read", async () => {
    const group = {
      id: "g1",
      displayName: "Editors",
      members: ["u1"],
      created: user.created,
      lastModified: user.lastModified,
      revision: 4,
    };
    const { query, calls } = recorder((call) =>
      call.text.includes("scim_groups") && !call.text.startsWith("insert")
        ? [{ resource: group }]
        : [{ resource: user }],
    );
    const store = postgresDirectoryStore(query);
    const patched = await store.patchUser("acme", "u1", [
      { op: "replace", path: "active", value: false },
    ]);
    expect(patched.id).toBe("u1");
    expect(calls[1]?.values[4]).toBe(false);
    expect(calls[1]?.values[7]).toBe(1);
    await store.patchGroup("acme", "g1", [
      { op: "add", path: "members", value: [{ value: "u2" }] },
    ]);
    expect(calls[3]?.values[6]).toBe(4);
    expect(calls[3]?.values[8]).toEqual(["u1", "u2"]);
  });

  it("maps a unique violation on a group PATCH and rethrows other write errors", async () => {
    const group = {
      id: "g1",
      displayName: "Editors",
      members: [],
      created: user.created,
      lastModified: user.lastModified,
      revision: 1,
    };
    const failing = (error: Error) =>
      postgresDirectoryStore(
        recorder((call) => {
          if (call.text.startsWith("select")) {
            return [{ resource: group }];
          }
          throw error;
        }).query,
      );
    await expect(
      failing(
        Object.assign(new Error("duplicate key"), { code: "23505" }),
      ).patchGroup("acme", "g1", [
        { op: "replace", path: "externalId", value: "dup" },
      ]),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isDirectoryUniquenessError(error) && error.message === "externalId",
    );
    await expect(
      failing(new Error("connection lost")).putGroup("acme", {
        id: "g1",
        displayName: "Editors",
        members: [],
        meta: { created: "", lastModified: "" },
      }),
    ).rejects.toThrow("connection lost");
    await expect(
      postgresDirectoryStore(
        recorder((call) => {
          if (call.text.startsWith("select")) {
            return [{ resource: user }];
          }
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            detail: "Key (tenant, user_name)=(acme, ada) already exists.",
          });
        }).query,
      ).patchUser("acme", "u1", []),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isDirectoryUniquenessError(error) && error.message === "userName",
    );
  });

  it("deletes a group and lists a user's groups", async () => {
    const group = {
      id: "g1",
      displayName: "Editors",
      members: ["u1"],
      created: user.created,
      lastModified: user.lastModified,
      revision: 1,
    };
    const { query, calls } = recorder((call) => {
      if (call.text.startsWith("delete")) {
        return call.values[1] === "g1" ? [{ id: "g1" }] : [];
      }
      return [{ resource: group }];
    });
    const store = postgresDirectoryStore(query);
    await expect(store.deleteGroup("acme", "g1")).resolves.toBeUndefined();
    await expect(store.deleteGroup("acme", "g2")).rejects.toSatisfy(
      isDirectoryNotFoundError,
    );
    await expect(store.groupsFor("acme", "u1")).resolves.toEqual([
      {
        id: "g1",
        displayName: "Editors",
        members: [{ value: "u1" }],
        meta: {
          created: user.created,
          lastModified: user.lastModified,
          resourceType: "Group",
        },
      },
    ]);
    expect(calls[2]?.values).toEqual(["acme", "u1"]);
  });

  it("refuses a schema that is not a plain identifier", () => {
    expect(() =>
      postgresDirectoryStore(recorder(() => []).query, { schema: "a;b" }),
    ).toThrow(/unsafe SQL identifier/u);
  });
});
