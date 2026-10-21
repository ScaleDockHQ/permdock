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

  it("refuses a schema that is not a plain identifier", () => {
    expect(() =>
      postgresDirectoryStore(recorder(() => []).query, { schema: "a;b" }),
    ).toThrow(/unsafe SQL identifier/u);
  });
});
