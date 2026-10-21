import { describe, expect, it } from "vitest";

import {
  createPermDock,
  parseAuthzenRequest,
  readAuthzenRequest,
  searchActions,
  searchSubjects,
} from "../../src/authzen/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  policy,
} from "../fixtures/quick-start.ts";

const ORIGIN = "https://pdp.example";

const subject = { type: "user", id: "u1" };
const action = { name: "read" };
const resource = { type: "post", id: "p1" };

function detail(result: ReturnType<typeof parseAuthzenRequest>): unknown {
  return result.ok ? result.request : result.problem.detail;
}

describe("parseAuthzenRequest", () => {
  it.each<[Parameters<typeof parseAuthzenRequest>[0], unknown, string]>([
    ["evaluation", [], "evaluation body must be an object"],
    ["evaluation", { action, resource }, "subject.type is required"],
    [
      "evaluation",
      { subject: { type: "user" }, action, resource },
      "subject.id is required",
    ],
    ["evaluation", { subject, action }, "resource.type is required"],
    [
      "evaluation",
      { subject, action, resource: { type: "post", id: 1 } },
      "resource.id is required",
    ],
    ["evaluation", { subject, resource }, "action.name is required"],
    ["evaluations", { evaluations: {} }, "evaluations must be an array"],
    ["evaluations", { subject, resource }, "action.name is required"],
    [
      "evaluations",
      {
        evaluations: [{ subject, action, resource }],
        options: { evaluations_semantic: "maybe" },
      },
      "options.evaluations_semantic must be one of execute_all, deny_on_first_deny, permit_on_first_permit",
    ],
    ["search/action", { subject }, "resource.type is required"],
    [
      "search/resource",
      { subject, resource: { type: "post" } },
      "action.name is required",
    ],
    [
      "search/subject",
      { subject: {}, action, resource },
      "subject.type is required",
    ],
    [
      "search/subject",
      { subject: { type: "user" }, action, resource: { type: "post" } },
      "resource.id is required",
    ],
  ])("%s %j answers %s", (kind, body, message) => {
    expect(detail(parseAuthzenRequest(kind, body))).toBe(message);
  });

  it("answers the same 400 the handler sends", async () => {
    const handler = createPermDock(policy, {
      subject: () => memberUser,
    }).permdockHandler();
    const body = { subject: { type: "user" }, action, resource };
    const response = await handler(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const parsed = parseAuthzenRequest("evaluation", body);
    expect(parsed.ok).toBe(false);
    expect(await response.json()).toEqual(parsed.ok ? null : parsed.problem);
  });

  it("parses an empty evaluations batch as one evaluation and merges items", () => {
    expect(
      parseAuthzenRequest("evaluations", { subject, action, resource }),
    ).toEqual({
      ok: true,
      request: { kind: "evaluation", item: { subject, action, resource } },
    });
    expect(
      parseAuthzenRequest("evaluations", {
        subject,
        resource,
        evaluations: [{ action }, { action: { name: "update" } }],
      }),
    ).toEqual({
      ok: true,
      request: {
        kind: "evaluations",
        semantic: "execute_all",
        items: [
          { subject, resource, action },
          { subject, resource, action: { name: "update" } },
        ],
      },
    });
  });

  it("refuses a batch over maxEvaluations with a 413", () => {
    const result = parseAuthzenRequest(
      "evaluations",
      { evaluations: [{}, {}, {}] },
      { maxEvaluations: 2 },
    );
    expect(result.ok ? null : result.problem.status).toBe(413);
  });

  it("reads the page of a search", () => {
    expect(
      parseAuthzenRequest("search/action", {
        subject,
        resource,
        page: { next_token: "4", size: 900 },
      }),
    ).toEqual({
      ok: true,
      request: {
        kind: "search/action",
        item: { subject, resource, page: { next_token: "4", size: 900 } },
        page: { offset: 4, size: 200 },
      },
    });
  });
});

describe("readAuthzenRequest", () => {
  function request(body: string, type = "application/json"): Request {
    return new Request(`${ORIGIN}/access/v1/evaluation`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  }

  it("checks the content type, the size and the JSON before the fields", async () => {
    const results = await Promise.all([
      readAuthzenRequest("evaluation", request("{}", "text/plain")),
      readAuthzenRequest("evaluation", request("{")),
      readAuthzenRequest("evaluation", request("x".repeat(1_048_577))),
      readAuthzenRequest(
        "evaluation",
        request(JSON.stringify({ subject, action, resource })),
      ),
    ]);
    expect(
      results.map((result) =>
        result.ok
          ? result.request.kind
          : [result.problem.status, result.problem.detail],
      ),
    ).toEqual([
      [400, "AuthZEN requests must use Content-Type: application/json"],
      [400, "AuthZEN body was not valid JSON"],
      [413, "request body exceeds 1048576 bytes"],
      "evaluation",
    ]);
  });
});

describe("searchActions", () => {
  it("answers the distinct granted actions of the resource type", async () => {
    const member = await searchActions(
      policy,
      memberUser,
      { type: "post", id: "p1" },
      { data: ownPost },
    );
    expect(member.map((entry) => entry.name)).toEqual([
      "read",
      "update",
      "create",
      "list",
    ]);
    const admin = await searchActions(policy, adminUser, {
      type: "post",
      properties: otherPost,
    });
    expect(admin.map((entry) => entry.name)).toEqual([
      "read",
      "update",
      "delete",
      "create",
      "list",
    ]);
    expect(
      await searchActions(policy, memberUser, { type: "comment" }),
    ).toEqual([]);
  });

  it("agrees with the handler's search/action", async () => {
    const handler = createPermDock(policy, {
      subject: () => memberUser,
    }).permdockHandler();
    const response = await handler(
      new Request(`${ORIGIN}/access/v1/search/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          resource: { type: "post", id: "p1", properties: ownPost },
        }),
      }),
    );
    // SAFETY: a search/action response is an AuthZEN page object.
    const body = (await response.json()) as { readonly results: unknown };
    expect(body.results).toEqual(
      await searchActions(policy, memberUser, {
        type: "post",
        properties: ownPost,
      }),
    );
  });
});

describe("searchSubjects", () => {
  const records = [
    { id: memberUser.id, orgId: "o1", roles: memberUser.roles },
    { id: adminUser.id, orgId: "o1", roles: adminUser.roles },
  ];

  it("asks the lister and keeps the granted candidates", async () => {
    const queries: unknown[] = [];
    const found = await searchSubjects(
      policy,
      {
        name: "directory",
        list: (query) => {
          queries.push(query);
          return records;
        },
      },
      {
        subject: { type: "user" },
        action: { name: "publish" },
        resource: { type: "post", id: "p1", properties: ownPost },
      },
    );
    expect(found).toEqual([{ type: "user", id: adminUser.id }]);
    expect(queries).toEqual([
      {
        type: "user",
        action: { name: "publish" },
        resource: { type: "post", id: "p1", properties: ownPost },
      },
    ]);
  });

  it("answers none for an unknown action, another type or a failing lister", async () => {
    const lister = { list: () => records };
    const request = {
      subject: { type: "user" },
      action: { name: "read" },
      resource: { type: "post", id: "p1" },
    };
    expect(
      await Promise.all([
        searchSubjects(policy, lister, { ...request, action: { name: "fly" } }),
        searchSubjects(policy, lister, {
          ...request,
          subject: { type: "agent" },
        }),
        searchSubjects(
          policy,
          { list: () => Promise.reject(new Error("down")) },
          request,
        ),
      ]),
    ).toEqual([[], [], []]);
  });
});
