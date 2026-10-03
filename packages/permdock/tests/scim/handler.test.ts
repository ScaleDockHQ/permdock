import { describe, expect, it, vi } from "vitest";

import type { TokenVerifier } from "../../src/core/interfaces.ts";
import type { RevocationEvent } from "../../src/core/revocations.ts";
import type { DirectoryChange, DirectoryStore } from "../../src/scim/types.ts";

import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { sha256Hex } from "../../src/scim/auth.ts";
import { scimHandler } from "../../src/scim/handler.ts";
import { memoryDirectoryStore } from "../../src/scim/store.ts";
import {
  GROUP_SCHEMA,
  PATCH_SCHEMA,
  ROLES_EXTENSION,
  USER_SCHEMA,
} from "../../src/scim/types.ts";

const TOKEN = "scim-secret";
const TENANT = "o_acme";
const BASE = "https://app.example.com/scim/v2";

function setup(
  extras: Partial<Parameters<typeof scimHandler>[0]> = {},
  store: DirectoryStore = memoryDirectoryStore(),
  withToken = true,
) {
  const hash = sha256Hex(TOKEN);
  return {
    store,
    handle: scimHandler({
      store,
      tenant: TENANT,
      ...(withToken
        ? { token: { hash: "sha256" as const, lookup: () => hash } }
        : {}),
      ...extras,
    }),
  };
}

function call(
  path: string,
  init: { method?: string; body?: unknown; raw?: string; token?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/scim+json" });
  headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
  const body =
    init.raw ??
    (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: every SCIM response body read in this file is a JSON object.
  return (await response.json()) as Record<string, unknown>;
}

async function expectError(
  response: Response,
  status: number,
  scimType: string,
): Promise<void> {
  expect({ status: response.status, body: await json(response) }).toMatchObject(
    {
      status,
      body: { status: String(status), scimType },
    },
  );
}

const userBody = (fields: Record<string, unknown> = {}) => ({
  schemas: [USER_SCHEMA],
  userName: "ada",
  ...fields,
});
const groupBody = (fields: Record<string, unknown> = {}) => ({
  schemas: [GROUP_SCHEMA],
  displayName: "Eng",
  ...fields,
});

describe("scimHandler configuration", () => {
  it("requires a token or a verifier", () => {
    expect(() =>
      scimHandler({ store: memoryDirectoryStore(), tenant: TENANT }),
    ).toThrow(/token or verifier/);
  });
});

describe("scimHandler routing and tenancy", () => {
  it("answers 404 for an unknown route", async () => {
    const { handle } = setup();
    await expectError(await handle(call("/Nope")), 404, "invalidValue");
  });

  it("refuses when the tenant resolver throws or returns empty", async () => {
    const throwing = setup({
      tenant: () => {
        throw new Error("no tenant");
      },
    });
    const empty = setup({ tenant: () => Promise.resolve("") });
    expect((await throwing.handle(call("/Users"))).status).toBe(403);
    const response = await empty.handle(call("/Users"));
    expect({
      status: response.status,
      challenge: response.headers.get("www-authenticate"),
    }).toEqual({ status: 403, challenge: "Bearer" });
  });

  it("refuses a missing or wrong bearer token", async () => {
    const { handle } = setup();
    const missing = await handle(new Request(`${BASE}/Users`));
    const wrong = await handle(call("/Users", { token: "other" }));
    const scheme = await handle(
      new Request(`${BASE}/Users`, {
        headers: { authorization: `Basic ${TOKEN}` },
      }),
    );
    expect([missing.status, wrong.status, scheme.status]).toEqual([
      401, 401, 401,
    ]);
  });

  it.each([
    ["no stored hash", () => undefined],
    ["an odd-length hash", () => "abc"],
    ["a non-hex hash", () => "zz".repeat(32)],
    ["a short hash", () => "ab"],
  ])("refuses the token when the tenant has %s", async (_label, lookup) => {
    const { handle } = setup({ token: { hash: "sha256", lookup } });
    expect((await handle(call("/Users"))).status).toBe(401);
  });

  it("never answers another tenant from the same store", async () => {
    const store = memoryDirectoryStore();
    const acme = setup({}, store);
    const other = setup({ tenant: "o_other" }, store);
    const created = await json(
      await acme.handle(call("/Users", { method: "POST", body: userBody() })),
    );
    const id = String(created["id"]);
    expect((await other.handle(call(`/Users/${id}`))).status).toBe(404);
    expect(await json(await other.handle(call("/Users")))).toMatchObject({
      totalResults: 0,
    });
    expect(
      (await other.handle(call(`/Users/${id}`, { method: "DELETE" }))).status,
    ).toBe(404);
    expect(
      (
        await other.handle(
          call(`/Users/${id}`, {
            method: "PATCH",
            body: {
              schemas: [PATCH_SCHEMA],
              Operations: [{ op: "replace", path: "active", value: false }],
            },
          }),
        )
      ).status,
    ).toBe(404);
    expect(await json(await acme.handle(call(`/Users/${id}`)))).toMatchObject({
      active: true,
    });
  });
});

describe("scimHandler with a verifier", () => {
  function verifierFor(
    claims: Record<string, unknown> | undefined,
  ): TokenVerifier {
    return {
      verify: async () =>
        claims === undefined
          ? { ok: false, reason: "invalid-token", cause: "invalid-signature" }
          : {
              ok: true,
              claims: { sub: "relay", ...claims },
              header: { alg: "EdDSA" },
            },
    };
  }

  it.each<[string, Record<string, unknown> | undefined, number]>([
    ["a tid claim", { tid: TENANT }, 200],
    ["an empty tenant falling back to tid", { tenant: "", tid: TENANT }, 200],
    ["no tenant claim", {}, 403],
    ["an empty tid", { tid: "" }, 403],
    ["a numeric tenant", { tenant: 1 }, 403],
    ["a failed verification", undefined, 401],
  ])("answers %s with %i", async (_label, claims, status) => {
    const { handle } = setup(
      { verifier: verifierFor(claims), audience: BASE },
      undefined,
      false,
    );
    expect((await handle(call("/Users", { token: "jwt" }))).status).toBe(
      status,
    );
  });

  it("falls back to the verifier when the static token does not match", async () => {
    const changes: DirectoryChange[] = [];
    const sink = {
      write: vi.fn<(events: readonly unknown[]) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    };
    const { handle } = setup({
      verifier: verifierFor({ tenant: TENANT, iss: "https://idp" }),
      audience: BASE,
      sink,
      onChange: (change) => {
        changes.push(change);
      },
    });
    const response = await handle(
      call("/Users", { method: "POST", body: userBody(), token: "jwt" }),
    );
    expect(response.status).toBe(201);
    expect(sink.write.mock.calls[0]?.[0]).toMatchObject([
      { type: "directory", credential: { kind: "jwt", iss: "https://idp" } },
    ]);
    expect(changes).toMatchObject([{ tenant: TENANT, kind: "changed" }]);
  });
});

describe("scimHandler discovery", () => {
  it("refuses a filter on discovery endpoints", async () => {
    const { handle } = setup();
    await expectError(
      await handle(call("/Schemas?filter=id%20pr")),
      403,
      "invalidFilter",
    );
  });

  it("answers 404 for an unknown schema or resource type id", async () => {
    const { handle } = setup();
    await expectError(
      await handle(call("/Schemas/urn:nope")),
      404,
      "invalidValue",
    );
    const types = await handle(call("/ResourceTypes/Nope"));
    expect(await json(types)).toMatchObject({
      detail: "ResourceType not found",
    });
    const one = await json(await handle(call(`/ResourceTypes/User`)));
    expect(one).toMatchObject({
      id: "User",
      meta: { resourceType: "ResourceType" },
    });
  });
});

describe("scimHandler list and get", () => {
  it.each(['userName gt "a"', 'title eq "x"', "userName eq"])(
    "refuses the filter %j",
    async (filter) => {
      const { handle } = setup();
      await expectError(
        await handle(call(`/Users?filter=${encodeURIComponent(filter)}`)),
        400,
        "invalidFilter",
      );
    },
  );

  it("ignores an empty filter", async () => {
    const { handle } = setup();
    expect((await handle(call("/Users?filter="))).status).toBe(200);
  });

  it("lists, filters and gets groups", async () => {
    const { handle } = setup();
    const created = await json(
      await handle(call("/Groups", { method: "POST", body: groupBody() })),
    );
    await handle(
      call("/Groups", {
        method: "POST",
        body: groupBody({ displayName: "Ops" }),
      }),
    );
    const listed = await json(
      await handle(
        call(`/Groups?filter=${encodeURIComponent('displayName eq "Eng"')}`),
      ),
    );
    expect(listed).toMatchObject({
      totalResults: 1,
      Resources: [
        {
          id: created["id"],
          meta: { location: `${BASE}/Groups/${String(created["id"])}` },
        },
      ],
    });
    const paged = await json(
      await handle(call("/Groups?startIndex=2&count=1")),
    );
    expect(paged).toMatchObject({
      totalResults: 2,
      startIndex: 2,
      itemsPerPage: 1,
    });
    const one = await json(
      await handle(call(`/Groups/${String(created["id"])}`)),
    );
    expect(one).toMatchObject({ displayName: "Eng", schemas: [GROUP_SCHEMA] });
    await expectError(
      await handle(call("/Groups/g_missing")),
      404,
      "invalidValue",
    );
  });
});

describe("scimHandler writes", () => {
  it("refuses malformed and non-object bodies", async () => {
    const { handle } = setup();
    await expectError(
      await handle(call("/Users", { method: "POST", raw: "{not json" })),
      400,
      "invalidSyntax",
    );
    await expectError(
      await handle(call("/Users", { method: "POST", raw: "[1]" })),
      400,
      "invalidSyntax",
    );
    await expectError(
      await handle(call("/Users", { method: "POST", raw: "" })),
      400,
      "invalidSyntax",
    );
  });

  it.each<[string, string, string, unknown, number, string]>([
    [
      "POST user without schemas",
      "POST",
      "/Users",
      { userName: "a" },
      400,
      "invalidSyntax",
    ],
    [
      "POST user with a group schema",
      "POST",
      "/Users",
      groupBody(),
      400,
      "invalidSyntax",
    ],
    [
      "POST user without userName",
      "POST",
      "/Users",
      userBody({ userName: "" }),
      400,
      "invalidValue",
    ],
    [
      "POST group with a user schema",
      "POST",
      "/Groups",
      userBody(),
      400,
      "invalidSyntax",
    ],
    [
      "POST group without displayName",
      "POST",
      "/Groups",
      groupBody({ displayName: 3 }),
      400,
      "invalidValue",
    ],
    [
      "PUT user with a bad schema",
      "PUT",
      "/Users/u_1",
      { schemas: "x" },
      400,
      "invalidSyntax",
    ],
    [
      "PUT a missing user",
      "PUT",
      "/Users/u_missing",
      userBody(),
      404,
      "invalidValue",
    ],
    [
      "PUT group with a bad schema",
      "PUT",
      "/Groups/g_1",
      userBody(),
      400,
      "invalidSyntax",
    ],
    [
      "PUT a missing group",
      "PUT",
      "/Groups/g_missing",
      groupBody(),
      404,
      "invalidValue",
    ],
    [
      "PUT a group without displayName",
      "PUT",
      "/Groups/g_seed",
      groupBody({ displayName: "" }),
      400,
      "invalidValue",
    ],
    [
      "DELETE a missing user",
      "DELETE",
      "/Users/u_missing",
      undefined,
      404,
      "invalidValue",
    ],
    [
      "PATCH without Operations",
      "PATCH",
      "/Users/u_1",
      { schemas: [PATCH_SCHEMA] },
      400,
      "invalidSyntax",
    ],
    [
      "PATCH with an unknown op",
      "PATCH",
      "/Users/u_1",
      { Operations: [{ op: "move" }] },
      400,
      "invalidSyntax",
    ],
    ["POST to an id", "POST", "/Users/u_1", userBody(), 405, "invalidValue"],
    ["PUT without an id", "PUT", "/Groups", groupBody(), 405, "invalidValue"],
    [
      "PATCH a missing group",
      "PATCH",
      "/Groups/g_missing",
      { Operations: [{ op: "add", path: "displayName", value: "x" }] },
      404,
      "invalidValue",
    ],
  ])("%s", async (_label, method, path, body, status, scimType) => {
    const { handle, store } = setup();
    await handle(
      call("/Users", { method: "POST", body: userBody({ userName: "seed" }) }),
    );
    await store.putGroup(TENANT, {
      id: "g_seed",
      displayName: "Seed",
      members: [],
      meta: { created: "", lastModified: "" },
    });
    await expectError(
      await handle(call(path, { method, body })),
      status,
      scimType,
    );
  });

  it("refuses a PUT that drops userName and keeps the stored user", async () => {
    const { handle, store } = setup();
    const created = await store.putUser(TENANT, {
      id: "u_1",
      userName: "ada",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    await expectError(
      await handle(
        call("/Users/u_1", {
          method: "PUT",
          body: userBody({ userName: undefined }),
        }),
      ),
      400,
      "invalidValue",
    );
    expect(await store.getUser(TENANT, "u_1")).toEqual(created);
  });

  it("replaces a group, emits membership changes and reports unknown roles", async () => {
    const unknown: string[] = [];
    const sink = {
      write: vi.fn<(events: readonly unknown[]) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    };
    const { handle, store } = setup({
      sink,
      assignable: ["member"],
      onUnknownRole: (name) => {
        unknown.push(name);
      },
    });
    await store.putGroup(TENANT, {
      id: "g_1",
      displayName: "Eng",
      members: [{ value: "u_1" }, { value: "u_2" }],
      roles: ["member"],
      meta: { created: "", lastModified: "" },
    });
    const response = await handle(
      call("/Groups/g_1", {
        method: "PUT",
        body: groupBody({
          members: [{ value: "u_2" }, { value: "u_3" }, { nope: 1 }, "x"],
          [ROLES_EXTENSION]: { roles: ["member", "root", 5] },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBe(`${BASE}/Groups/g_1`);
    expect(await json(response)).toMatchObject({
      schemas: [GROUP_SCHEMA, ROLES_EXTENSION],
      members: [{ value: "u_2" }, { value: "u_3" }],
      [ROLES_EXTENSION]: { roles: ["member", "root"] },
    });
    expect(unknown).toEqual(["root"]);
    const events = sink.write.mock.calls[0]?.[0];
    expect(events).toMatchObject([
      {
        type: "directory",
        operation: "replace",
        resource: { type: "Group", id: "g_1" },
      },
      {
        operation: "added",
        principal: { id: "u_3" },
        roles: { added: ["member", "root"] },
      },
      {
        operation: "removed",
        principal: { id: "u_1" },
        roles: { removed: ["member", "root"] },
      },
    ]);
  });

  it("keeps the stored roles when a replacing group carries none", async () => {
    const sink = {
      write: vi.fn<(events: readonly unknown[]) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    };
    const { handle, store } = setup({ sink });
    await store.putGroup(TENANT, {
      id: "g_1",
      displayName: "Eng",
      members: [],
      roles: ["viewer"],
      meta: { created: "", lastModified: "" },
    });
    await handle(
      call("/Groups/g_1", {
        method: "PUT",
        body: groupBody({ members: [{ value: "u_1" }] }),
      }),
    );
    expect(sink.write.mock.calls[0]?.[0]).toMatchObject([
      { operation: "replace" },
      { operation: "added", roles: { added: ["viewer"] } },
    ]);
    await store.putGroup(TENANT, {
      id: "g_2",
      displayName: "Bare",
      members: [],
      meta: { created: "", lastModified: "" },
    });
    await handle(
      call("/Groups/g_2", {
        method: "PUT",
        body: groupBody({ members: [{ value: "u_1" }] }),
      }),
    );
    expect(sink.write.mock.calls[1]?.[0]).toMatchObject([
      { operation: "replace" },
      { operation: "added", roles: { added: [] } },
    ]);
  });

  it("deletes a group with its members and an unknown group as 404", async () => {
    const feed = memoryRevocationFeed();
    const revoked: RevocationEvent[] = [];
    feed.subscribe((event) => {
      revoked.push(event);
    });
    const { handle, store } = setup({
      revocations: feed,
      groupRoles: { g_1: ["member"] },
    });
    await store.putUser(TENANT, {
      id: "u_1",
      userName: "ada",
      externalId: "ext-ada",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    await store.putGroup(TENANT, {
      id: "g_1",
      displayName: "Eng",
      members: [{ value: "u_1" }],
      meta: { created: "", lastModified: "" },
    });
    expect(
      (await handle(call("/Groups/g_1", { method: "DELETE" }))).status,
    ).toBe(204);
    expect(revoked.map((event) => [event.principal, event.kind])).toEqual([
      ["u_1", "changed"],
      ["ada", "changed"],
      ["ext-ada", "changed"],
    ]);
    expect(
      (await handle(call("/Groups/g_1", { method: "DELETE" }))).status,
    ).toBe(404);
  });

  it("patches users and groups", async () => {
    const { handle, store } = setup();
    await store.putUser(TENANT, {
      id: "u_1",
      userName: "ada",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    const user = await handle(
      call("/Users/u_1", {
        method: "PATCH",
        body: {
          schemas: [PATCH_SCHEMA],
          operations: [{ op: "replace", value: { active: "False" } }],
        },
      }),
    );
    expect(await json(user)).toMatchObject({ active: false });
    const group = await handle(
      call("/Groups", { method: "POST", body: groupBody({ id: "ignored" }) }),
    );
    const id = String((await json(group))["id"]);
    const patched = await handle(
      call(`/Groups/${id}`, {
        method: "PATCH",
        body: {
          Operations: [
            { op: "add", path: "members", value: [{ value: "u_1" }] },
          ],
        },
      }),
    );
    expect(await json(patched)).toMatchObject({ members: [{ value: "u_1" }] });
  });

  it("maps a store failure to 500 and a uniqueness failure to 409", async () => {
    const base = memoryDirectoryStore();
    const failing: DirectoryStore = {
      ...base,
      findUsers: () => Promise.reject(new Error("db down")),
    };
    const { handle } = setup({}, failing);
    await expectError(await handle(call("/Users")), 500, "invalidValue");
    await handle(
      call("/Groups", { method: "POST", body: groupBody({ externalId: "x" }) }),
    );
    await expectError(
      await handle(
        call("/Groups", {
          method: "POST",
          body: groupBody({ externalId: "x" }),
        }),
      ),
      409,
      "uniqueness",
    );
  });

  it("survives a throwing sink, onChange and revocation feed", async () => {
    const { handle } = setup({
      sink: { write: () => Promise.reject(new Error("sink down")) },
      onChange: () => {
        throw new Error("cache down");
      },
      revocations: {
        ...memoryRevocationFeed(),
        revoke: () => Promise.reject(new Error("feed down")),
      },
    });
    const created = await handle(
      call("/Users", { method: "POST", body: userBody() }),
    );
    expect(created.status).toBe(201);
    const id = String((await json(created))["id"]);
    expect(
      (await handle(call(`/Users/${id}`, { method: "DELETE" }))).status,
    ).toBe(204);
  });

  it("looks up principal ids from the store and tolerates a failing read", async () => {
    const feed = memoryRevocationFeed();
    const revoked: string[] = [];
    feed.subscribe((event) => {
      revoked.push(event.principal);
    });
    const base = memoryDirectoryStore();
    const store: DirectoryStore = {
      ...base,
      getUser: (tenant, id) =>
        id === "u_broken"
          ? Promise.reject(new Error("read failed"))
          : base.getUser(tenant, id),
    };
    const { handle } = setup({ revocations: feed }, store);
    await base.putUser(TENANT, {
      id: "u_1",
      userName: "ada",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    await handle(
      call("/Groups", {
        method: "POST",
        body: groupBody({ members: [{ value: "u_1" }, { value: "u_broken" }] }),
      }),
    );
    expect(revoked).toEqual(["u_1", "ada", "u_broken"]);
  });
});
