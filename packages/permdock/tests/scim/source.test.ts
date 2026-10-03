import { describe, expect, it } from "vitest";

import type { DirectoryStore } from "../../src/scim/types.ts";

import { groupFromBody, schemasOk, userFromBody } from "../../src/scim/body.ts";
import {
  locationOf,
  parseRoute,
  tenantFromPath,
} from "../../src/scim/route.ts";
import { directoryMembershipSource } from "../../src/scim/source.ts";
import { memoryDirectoryStore } from "../../src/scim/store.ts";
import { PATCH_SCHEMA, USER_SCHEMA } from "../../src/scim/types.ts";

const TENANT = "o_acme";
const META = { created: "", lastModified: "" };

async function seeded(): Promise<DirectoryStore> {
  const store = memoryDirectoryStore();
  await store.putUser(TENANT, {
    id: "u_1",
    userName: "ada@example.com",
    externalId: "ext-1",
    active: true,
    meta: META,
  });
  await store.putGroup(TENANT, {
    id: "g_mapped",
    displayName: "Mapped",
    members: [{ value: "u_1" }],
    meta: META,
  });
  await store.putGroup(TENANT, {
    id: "g_none",
    displayName: "None",
    members: [{ value: "u_1" }],
    meta: META,
  });
  return store;
}

describe("directoryMembershipSource", () => {
  it("answers nothing without a tenant", async () => {
    const source = directoryMembershipSource(await seeded());
    expect(await source.membershipsFor({ id: "ext-1" }, {})).toEqual([]);
    expect(
      await source.membershipsFor({ id: "ext-1" }, { tenant: "" }),
    ).toEqual([]);
  });

  it("never answers from another tenant", async () => {
    const source = directoryMembershipSource(await seeded());
    expect(
      await source.membershipsFor({ id: "ext-1" }, { tenant: "o_other" }),
    ).toEqual([]);
  });

  it("maps groups through groupRoles and gives an unmapped group no roles", async () => {
    const source = directoryMembershipSource(await seeded(), {
      groupRoles: { g_mapped: ["editor"] },
    });
    expect(
      await source.membershipsFor({ id: "ext-1" }, { tenant: TENANT }),
    ).toEqual([
      {
        tenant: TENANT,
        roles: ["editor"],
        via: "group:g_mapped",
        managedBy: "idp",
      },
      { tenant: TENANT, roles: [], via: "group:g_none", managedBy: "idp" },
    ]);
  });

  it.each<["externalId" | "userName" | "either", string, number]>([
    ["userName", "ada@example.com", 2],
    ["userName", "ext-1", 0],
    ["externalId", "ada@example.com", 0],
    ["either", "ada@example.com", 2],
  ])("match %s finds %s in %i groups", async (match, id, count) => {
    const source = directoryMembershipSource(await seeded(), { match });
    expect(
      await source.membershipsFor({ id }, { tenant: TENANT }),
    ).toHaveLength(count);
  });

  it("fails closed when the store throws", async () => {
    const base = await seeded();
    const lookupFails = directoryMembershipSource({
      ...base,
      findUsers: () => Promise.reject(new Error("down")),
    });
    const groupsFail = directoryMembershipSource({
      ...base,
      groupsFor: () => Promise.reject(new Error("down")),
    });
    expect(
      await lookupFails.membershipsFor({ id: "ext-1" }, { tenant: TENANT }),
    ).toEqual([]);
    expect(
      await groupsFail.membershipsFor({ id: "ext-1" }, { tenant: TENANT }),
    ).toEqual([]);
  });
});

describe("SCIM routes", () => {
  it.each<[string, string]>([
    ["https://a.example/scim/v2/o_acme/Users", "o_acme"],
    ["https://a.example/o_acme/Groups/g_1", "o_acme"],
    ["https://a.example/scim/v2/Users", ""],
    ["https://a.example/scim/Users", ""],
    ["https://a.example/Users", ""],
    ["https://a.example/nothing/here", ""],
  ])("tenantFromPath(%s) is %j", (url, tenant) => {
    expect(tenantFromPath(new Request(url))).toBe(tenant);
  });

  it.each<[string, unknown]>([
    ["/scim/v2/Users/u_1", { kind: "Users", id: "u_1" }],
    ["/scim/v2/Groups", { kind: "Groups" }],
    ["/scim/v2/ServiceProviderConfig/extra", { kind: "ServiceProviderConfig" }],
    ["/scim/v2/Schemas/urn:x", { kind: "Schemas", id: "urn:x" }],
    ["/scim/v2/Bulk", undefined],
  ])("parseRoute(%s)", (path, route) => {
    expect(parseRoute(new URL(`https://a.example${path}`))).toEqual(route);
  });

  it("builds a location from the request prefix", () => {
    expect(
      locationOf(
        new Request("https://a.example/scim/v2/o_acme/Users?x=1"),
        "Users",
        "u_1",
      ),
    ).toBe("https://a.example/scim/v2/o_acme/Users/u_1");
    expect(locationOf(new Request("https://a.example/base"), "Schemas")).toBe(
      "https://a.example/base/Schemas",
    );
  });
});

describe("SCIM bodies", () => {
  it("accepts the resource schema or the PatchOp schema", () => {
    expect(schemasOk({ schemas: [USER_SCHEMA] }, USER_SCHEMA)).toBe(true);
    expect(schemasOk({ schemas: [PATCH_SCHEMA] }, USER_SCHEMA)).toBe(true);
    expect(schemasOk({ schemas: ["urn:other"] }, USER_SCHEMA)).toBe(false);
    expect(schemasOk({}, USER_SCHEMA)).toBe(false);
  });

  it("reads emails and active from a user body", () => {
    expect(
      userFromBody(
        {
          userName: "ada",
          externalId: "e",
          active: "False",
          emails: [
            { value: "a@x", primary: true, type: "work" },
            { value: "b@x", primary: "yes", type: 1 },
            { value: 2 },
            "c@x",
          ],
        },
        "u_1",
      ),
    ).toEqual({
      id: "u_1",
      userName: "ada",
      externalId: "e",
      active: false,
      emails: [{ value: "a@x", primary: true, type: "work" }, { value: "b@x" }],
      meta: META,
    });
    expect(userFromBody({ userName: "ada", active: "true" }, "")?.active).toBe(
      true,
    );
    expect(userFromBody({ userName: "ada", active: false }, "")?.active).toBe(
      false,
    );
    expect(userFromBody({ userName: "ada", active: 1 }, "")?.active).toBe(true);
    expect(userFromBody({ userName: 7 }, "")).toBeUndefined();
  });

  it("falls back to the configured roles without a roles extension", () => {
    expect(
      groupFromBody({ displayName: "Eng" }, "g", ["viewer"]),
    ).toMatchObject({
      roles: ["viewer"],
      members: [],
    });
    expect(groupFromBody({ displayName: "" }, "g", undefined)).toBeUndefined();
  });
});
