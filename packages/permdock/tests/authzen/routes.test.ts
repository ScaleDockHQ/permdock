import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/authzen/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  policy,
} from "../fixtures/quick-start.ts";

const ORIGIN = "https://pdp.example";
const PEP = { id: "pep", orgId: "o1", roles: ["admin"] };

type Options = Parameters<typeof createPermDock>[1];

function pdp(
  options: Partial<Options> = {},
): (request: Request) => Promise<Response> {
  return createPermDock(policy, {
    subject: () => PEP,
    // SAFETY: the PEP is the object returned by subject() above.
    trustedPep: (pep) => (pep as { readonly id?: unknown }).id === "pep",
    resources: {
      post: {
        load: (id) => (id === "p1" ? ownPost : id === "p2" ? otherPost : null),
        list: () => [
          ownPost,
          otherPost,
          { authorId: "u1", orgId: "o1", published: false },
        ],
      },
    },
    ...options,
  }).permdockHandler;
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: every AuthZEN response read here is a JSON object.
  return (await response.json()) as Record<string, unknown>;
}

const member = {
  type: "user",
  id: memberUser.id,
  properties: { orgId: memberUser.orgId, roles: memberUser.roles },
};

describe("AuthZEN routing", () => {
  it("answers 405 with Allow for a wrong method", async () => {
    const handle = pdp();
    const discovery = await handle(
      new Request(`${ORIGIN}/.well-known/authzen-configuration`, {
        method: "POST",
      }),
    );
    const evaluation = await handle(
      new Request(`${ORIGIN}/access/v1/evaluation`),
    );
    expect([
      [discovery.status, discovery.headers.get("allow")],
      [evaluation.status, evaluation.headers.get("allow")],
    ]).toEqual([
      [405, "GET"],
      [405, "POST"],
    ]);
  });

  it("answers 404 for an unknown path and echoes X-Request-ID", async () => {
    const response = await pdp()(
      new Request(`${ORIGIN}/access/v2/other`, {
        headers: { "x-request-id": "r-1" },
      }),
    );
    expect({
      status: response.status,
      id: response.headers.get("x-request-id"),
    }).toEqual({
      status: 404,
      id: "r-1",
    });
    const blank = await pdp()(
      new Request(`${ORIGIN}/nope`, { headers: { "x-request-id": "" } }),
    );
    expect(blank.headers.get("x-request-id")).toBeNull();
  });

  it("treats a throwing subject resolver as unauthenticated", async () => {
    const response = await pdp({
      subject: () => {
        throw new Error("bad token");
      },
    })(post("/access/v1/evaluation", {}));
    expect(response.status).toBe(401);
  });

  it("evaluates an anonymous PEP as anonymous when allowed", async () => {
    const response = await pdp({ subject: () => null, anonymous: true })(
      post("/access/v1/evaluation", {
        subject: member,
        action: { name: "read" },
        resource: { type: "post", id: "p1" },
      }),
    );
    expect(await json(response)).toMatchObject({
      decision: false,
      context: { permdock: { outcome: "denied" } },
    });
  });

  it("never trusts the body subject when trustedPep throws or is absent", async () => {
    for (const trustedPep of [
      () => {
        throw new Error("nope");
      },
      undefined,
    ]) {
      const response = await pdp({
        subject: () => ({ id: "u9", orgId: "o1", roles: [] }),
        ...(trustedPep === undefined ? {} : { trustedPep }),
      })(
        post("/access/v1/evaluation", {
          subject: {
            type: "user",
            id: "u2",
            properties: { orgId: "o1", roles: ["admin"] },
          },
          action: { name: "publish" },
          resource: { type: "post", id: "p1" },
        }),
      );
      expect((await json(response))["decision"]).toBe(false);
    }
  });
});

describe("AuthZEN evaluation", () => {
  it("refuses a non-object body", async () => {
    const response = await pdp()(post("/access/v1/evaluation", "[1]"));
    expect(response.status).toBe(400);
  });

  it("evaluates from a loaded row with the wire id or a bare resource id", async () => {
    const handle = pdp();
    const loaded = await handle(
      post("/access/v1/evaluation", {
        subject: member,
        action: { name: "update" },
        resource: { type: "post", id: "p1" },
      }),
    );
    expect((await json(loaded))["decision"]).toBe(true);
    const unloaded = await pdp({ resources: {} })(
      post("/access/v1/evaluation", {
        subject: member,
        action: { name: "read" },
        resource: { type: "post", id: 9 },
      }),
    );
    expect((await json(unloaded))["decision"]).toBe(false);
  });
});

describe("AuthZEN evaluations", () => {
  const items = [
    { resource: { type: "post", id: "p2" } },
    { resource: { type: "post", id: "p1" } },
    { resource: { type: "post", id: "p2" } },
  ];

  it.each([
    ["[]", "evaluations body must be an object"],
    ['{"evaluations":{}}', "evaluations must be an array"],
  ])("refuses %s", async (body, detail) => {
    const response = await pdp()(post("/access/v1/evaluations", body));
    expect(await json(response)).toMatchObject({ status: 400, detail });
  });

  it("refuses an unknown semantic", async () => {
    const response = await pdp()(
      post("/access/v1/evaluations", {
        subject: member,
        action: { name: "update" },
        evaluations: items,
        options: { evaluations_semantic: "majority" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("evaluates a body without evaluations as one evaluation", async () => {
    const response = await pdp()(
      post("/access/v1/evaluations", {
        subject: member,
        action: { name: "update" },
        resource: { type: "post", id: "p1" },
      }),
    );
    expect((await json(response))["decision"]).toBe(true);
  });

  it.each<[string, readonly boolean[]]>([
    ["deny_on_first_deny", [false]],
    ["permit_on_first_permit", [false, true]],
    ["execute_all", [false, true, false]],
  ])("%s stops where the semantic says", async (semantic, decisions) => {
    const response = await pdp()(
      post("/access/v1/evaluations", {
        subject: member,
        action: { name: "update" },
        evaluations: items,
        options: { evaluations_semantic: semantic },
      }),
    );
    const body = await json(response);
    // SAFETY: an evaluations response carries an evaluations array of rows.
    const rows = body["evaluations"] as readonly {
      readonly decision: boolean;
    }[];
    expect(rows.map((row) => row.decision)).toEqual(decisions);
  });

  it("defaults to execute_all when options carry no semantic", async () => {
    const response = await pdp()(
      post("/access/v1/evaluations", {
        subject: "not-a-record",
        action: { name: "read" },
        evaluations: [
          { subject: member, resource: { type: "post", id: "p1" } },
        ],
        options: "x",
      }),
    );
    expect(await json(response)).toMatchObject({
      evaluations: [{ decision: true }],
    });
  });
});

describe("AuthZEN search", () => {
  it.each(["action", "resource", "subject"])(
    "refuses a non-object search/%s body",
    async (kind) => {
      const handle = pdp({ subjects: { list: () => [] } });
      expect(
        (await handle(post(`/access/v1/search/${kind}`, '"x"'))).status,
      ).toBe(400);
      expect(
        (await handle(post(`/access/v1/search/${kind}`, "{bad"))).status,
      ).toBe(400);
    },
  );

  it("lists actions across every resource when no type is given", async () => {
    const response = await pdp()(
      post("/access/v1/search/action", {
        subject: member,
        page: { limit: 2 },
      }),
    );
    expect(await json(response)).toMatchObject({
      results: [{ name: "read" }, { name: "create" }],
      page: { count: 2, next_token: "2" },
    });
  });

  it("answers an empty page for an unknown resource search", async () => {
    const handle = pdp();
    for (const body of [
      { subject: member, action: { name: "read" } },
      {
        subject: member,
        action: { name: "archive" },
        resource: { type: "post" },
      },
    ]) {
      expect(
        await json(await handle(post("/access/v1/search/resource", body))),
      ).toEqual({
        results: [],
        page: { next_token: "", count: 0, total: 0 },
      });
    }
  });

  it("lists rows for a granted collection and none for a denied one", async () => {
    const handle = pdp();
    const granted = await handle(
      post("/access/v1/search/resource", {
        subject: member,
        action: { name: "list" },
        resource: { type: "post", properties: { orgId: "o1" } },
      }),
    );
    expect(await json(granted)).toMatchObject({
      results: [
        { type: "post", id: "p1" },
        { type: "post", id: "p2" },
      ],
      page: { total: 2 },
    });
    const denied = await handle(
      post("/access/v1/search/resource", {
        subject: {
          type: "user",
          id: "u9",
          properties: { orgId: "o1", roles: [] },
        },
        action: { name: "list" },
        resource: { type: "post" },
      }),
    );
    expect((await json(denied))["results"]).toEqual([]);
  });

  it("answers no rows without a list adapter or when it throws", async () => {
    for (const resources of [
      { post: {} },
      {
        post: {
          list: () => {
            throw new Error("db down");
          },
        },
      },
    ]) {
      const response = await pdp({ resources })(
        post("/access/v1/search/resource", {
          subject: member,
          action: { name: "read" },
          resource: { type: "post" },
        }),
      );
      expect((await json(response))["results"]).toEqual([]);
    }
  });

  it("answers search/subject only for users and survives a failing enumerator", async () => {
    const subjects = [
      { id: memberUser.id, orgId: "o1", roles: memberUser.roles },
      { id: adminUser.id, orgId: "o1", roles: adminUser.roles },
    ];
    const body = {
      subject: { type: "agent" },
      action: { name: "read" },
      resource: { type: "post", id: "p1" },
    };
    const agents = await pdp({ subjects: { list: () => subjects } })(
      post("/access/v1/search/subject", body),
    );
    expect((await json(agents))["results"]).toEqual([]);
    const failing = await pdp({
      subjects: { list: () => Promise.reject(new Error("down")) },
    })(
      post("/access/v1/search/subject", { ...body, subject: { type: "user" } }),
    );
    expect((await json(failing))["results"]).toEqual([]);
    const notConfigured = await pdp()(post("/access/v1/search/subject", body));
    expect(notConfigured.status).toBe(404);
  });
});
