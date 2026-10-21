import { describe, expect, it } from "vitest";

import type { AuthzenItem } from "../../src/authzen/map.ts";
import type { Decision } from "../../src/core/decision.ts";

import {
  actorOf,
  delegationOf,
  evaluationRow,
  mergeEvaluationItem,
  permissionOf,
  resourceData,
  resourceIdOf,
  tenantOf,
  userFromEntity,
} from "../../src/authzen/map.ts";
import {
  authzenPage,
  emptyAuthzenPage,
  readAuthzenPage,
} from "../../src/authzen/page.ts";
import { permissionLookup } from "../../src/server/evaluation-items.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe("permissionOf", () => {
  it.each<[string, AuthzenItem, string | undefined]>([
    [
      "a full key as the action name",
      { action: { name: "post.update" } },
      "post.update",
    ],
    [
      "an OAuth scope property",
      { action: { properties: { scope: "post.read" } } },
      "post.read",
    ],
    ["a non-string scope", { action: { properties: { scope: 1 } } }, undefined],
    [
      "non-record action properties",
      { action: { properties: "post.read" } },
      undefined,
    ],
    ["no action", {}, undefined],
    [
      "an action without a resource type",
      { action: { name: "update" } },
      undefined,
    ],
    [
      "a non-string resource type",
      { action: { name: "update" }, resource: { type: 1 } },
      undefined,
    ],
    [
      "the action within the resource type",
      { action: { name: "update" }, resource: { type: "post" } },
      "post.update",
    ],
    [
      "an unknown action",
      { action: { name: "archive" }, resource: { type: "post" } },
      undefined,
    ],
    [
      "an unknown resource",
      { action: { name: "read" }, resource: { type: "note" } },
      undefined,
    ],
  ])("resolves %s", (_label, item, key) => {
    expect(permissionOf(permissionLookup(permissions), item)?.key).toBe(key);
  });
});

describe("resource and subject mapping", () => {
  it.each<[AuthzenItem, unknown, string | undefined]>([
    [
      { resource: { properties: { id: "p1", a: 1 } } },
      { id: "p1", a: 1 },
      undefined,
    ],
    [{ resource: { id: "p1" } }, { id: "p1" }, "p1"],
    [{ resource: { id: 7 } }, { id: "7" }, "7"],
    [{ resource: { id: true, properties: null } }, undefined, undefined],
    [{}, undefined, undefined],
  ])("resourceData / resourceIdOf of %j", (item, data, id) => {
    expect({ data: resourceData(item), id: resourceIdOf(item) }).toEqual({
      data,
      id,
    });
  });

  it.each<[Parameters<typeof userFromEntity>[0], unknown]>([
    [undefined, null],
    [{}, null],
    [{ id: true, properties: "x" }, null],
    [{ id: 3 }, { id: "3" }],
    [
      {
        id: "u1",
        properties: { orgId: "o1", actor: { id: "bot" }, delegation: {} },
      },
      { id: "u1", orgId: "o1" },
    ],
    [{ properties: { actor: { id: "bot" } } }, null],
  ])("userFromEntity(%j)", (entity, user) => {
    expect(userFromEntity(entity)).toEqual(user);
  });

  it.each<[AuthzenItem, unknown]>([
    [{}, undefined],
    [{ context: "x" }, undefined],
    [
      { context: { actor: { id: "bot", kind: "agent" } } },
      { id: "bot", kind: "agent" },
    ],
    [
      { context: { actor: { id: "bot" } } },
      { id: "bot", kind: "oauth-client" },
    ],
    [{ context: { actor: { id: 1 } } }, undefined],
    [{ context: { actor: "bot" } }, undefined],
    [
      { subject: { properties: { actor: { id: "s", kind: 2 } } } },
      { id: "s", kind: "oauth-client" },
    ],
    [
      {
        context: { actor: { id: "ctx" } },
        subject: { properties: { actor: { id: "sub" } } },
      },
      { id: "ctx", kind: "oauth-client" },
    ],
  ])("actorOf(%j)", (item, actor) => {
    expect(actorOf(item)).toEqual(actor);
  });

  it.each<[AuthzenItem, unknown]>([
    [{}, undefined],
    [{ context: [] }, undefined],
    [{ context: { delegation: "all" } }, { scopes: [] }],
    [{ context: { delegation: {} } }, {}],
    [
      {
        context: {
          delegation: {
            scope: "post.read  post.update",
            authorization_details: [{ type: "x" }],
          },
        },
      },
      {
        scopes: ["post.read", "post.update"],
        authorizationDetails: [{ type: "x" }],
      },
    ],
    [
      {
        context: {
          delegation: { scopes: ["post.read"], authorizationDetails: [] },
        },
      },
      {},
    ],
    [
      {
        subject: {
          properties: {
            delegation: { scope: "post.read", authorization_details: {} },
          },
        },
      },
      { scopes: [] },
    ],
  ])("delegationOf(%j)", (item, delegation) => {
    expect(delegationOf(item)).toEqual(delegation);
  });

  it.each<[AuthzenItem, string | undefined]>([
    [{}, undefined],
    [{ context: { tenant: "o1" } }, "o1"],
    [{ context: { tenant: 1 } }, undefined],
  ])("tenantOf(%j)", (item, tenant) => {
    expect(tenantOf(item)).toBe(tenant);
  });
});

describe("evaluationRow", () => {
  it("maps every outcome to the PermDock context", () => {
    const granted = { outcome: "granted" } as const;
    expect(
      // SAFETY: evaluationRow reads only the outcome of a granted decision.
      evaluationRow(granted as unknown as Decision, "post.read"),
    ).toEqual({
      decision: true,
      context: { permdock: { outcome: "granted" } },
    });
    expect(
      evaluationRow(
        {
          outcome: "denied",
          denials: [
            { role: null, reason: "no-grant", detail: "unknown-permission" },
          ],
          alternatives: [permissions.post.read],
        },
        "post.purge",
      ),
    ).toEqual({
      decision: false,
      context: {
        permdock: {
          outcome: "denied",
          denials: [{ role: null, reason: "no-grant" }],
          reason: "unknown-permission",
        },
        reason_admin: { en: "post.purge denied: none (no-grant)." },
        reason_user: { en: "post.purge is not permitted." },
      },
    });
    expect(
      // SAFETY: evaluationRow reads only the outcome and token of an approval decision.
      evaluationRow(
        {
          outcome: "approval-required",
          reason: "human",
          token: "t",
        } as unknown as Decision,
        "post.delete",
      ),
    ).toEqual({
      decision: false,
      context: {
        permdock: { outcome: "approval-required", token: "t" },
        reason_admin: { en: "post.delete requires human approval (human)." },
        reason_user: { en: "post.delete requires approval." },
      },
    });
  });
});

describe("mergeEvaluationItem and paging", () => {
  const shared: AuthzenItem = {
    subject: { id: "s" },
    action: { name: "read" },
    resource: { type: "post" },
    context: { tenant: "o1" },
  };

  it("overrides only the record fields an item carries", () => {
    expect(mergeEvaluationItem(shared, "x")).toBe(shared);
    expect(
      mergeEvaluationItem(shared, {
        action: { name: "update" },
        subject: "bad",
      }),
    ).toEqual({ ...shared, action: { name: "update" } });
    expect(
      mergeEvaluationItem(shared, {
        subject: { id: "u" },
        resource: { type: "note" },
        context: { tenant: "o2" },
      }),
    ).toEqual({
      subject: { id: "u" },
      action: { name: "read" },
      resource: { type: "note" },
      context: { tenant: "o2" },
    });
  });

  it.each<[Record<string, unknown>, { offset: number; size: number }]>([
    [{}, { offset: 0, size: 50 }],
    [{ page: "x" }, { offset: 0, size: 50 }],
    [{ page: { token: "5", limit: 10 } }, { offset: 5, size: 10 }],
    [{ page: { next_token: "3", size: 500 } }, { offset: 3, size: 200 }],
    [{ page: { token: "-2", limit: 0 } }, { offset: 0, size: 50 }],
    [{ page: { token: "abc", limit: "5" } }, { offset: 0, size: 50 }],
  ])("readAuthzenPage(%j)", (body, page) => {
    expect(readAuthzenPage(body)).toEqual(page);
  });

  it("reads no page from a body that is not an object", () => {
    expect(readAuthzenPage(null)).toEqual({ offset: 0, size: 50 });
  });

  it("pages with a next token until the end", () => {
    expect(authzenPage([1, 2, 3], { offset: 0, size: 2 })).toEqual({
      results: [1, 2],
      page: { next_token: "2", count: 2, total: 3 },
    });
    expect(authzenPage([1, 2, 3], { offset: 2, size: 2 })).toEqual({
      results: [3],
      page: { next_token: "", count: 1, total: 3 },
    });
    expect(emptyAuthzenPage()).toEqual({
      results: [],
      page: { next_token: "", count: 0, total: 0 },
    });
  });
});
