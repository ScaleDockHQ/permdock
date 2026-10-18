import { describe, expect, it, vi } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { getPermDockSync as createCorePermDock } from "../../src/core/permdock.ts";
import { evaluationsHandler } from "../../src/server/index.ts";
import {
  InvalidSignatureError,
  invalidSignatureProblem,
} from "../../src/server/web-bot-auth.ts";
import {
  memberUser,
  ownPost,
  otherPost,
  policy,
} from "../fixtures/quick-start.ts";

const ENDPOINT = "https://api.example/access/v1/evaluations";

function post(body: unknown): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function handler(
  extra: Partial<Parameters<typeof evaluationsHandler>[0]> = {},
) {
  return evaluationsHandler({
    policy,
    resolve: async (): Promise<PermDock> =>
      createCorePermDock(policy, memberUser),
    ...extra,
  });
}

type Row = {
  readonly decision: boolean;
  readonly context: {
    readonly outcome: string;
    readonly permdock: Record<string, unknown>;
  };
};

async function rows(response: Response): Promise<readonly Row[]> {
  // SAFETY: a 200 evaluations response carries an evaluations array of rows.
  return ((await response.json()) as { readonly evaluations: readonly Row[] })
    .evaluations;
}

describe("evaluationsHandler POST", () => {
  it.each<[string, string]>([
    ["{nope", "evaluations body was not valid JSON"],
    ["[]", "evaluations body must be an object"],
    ["null", "evaluations body must be an object"],
    ["{}", "evaluations array is required"],
    ['{"evaluations":"x"}', "evaluations must be an array"],
  ])("refuses %s", async (body, detail) => {
    const response = await handler().POST(post(body));
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 400,
      body: { detail },
    });
  });

  it("resolves each item by key, by resource and action, or not at all", async () => {
    const response = await handler().POST(
      post({
        evaluations: [
          {
            action: { name: "post.update" },
            resource: { properties: ownPost },
          },
          {
            action: { name: "update" },
            resource: { type: "post", properties: otherPost },
          },
          { action: { name: "read" }, resource: { type: "post", id: 7 } },
          { action: { name: "list" }, resource: { type: "post" } },
          { action: { name: "archive" }, resource: { type: "post" } },
          { action: { name: "read" } },
          { action: {} },
          "junk",
          {
            action: { name: "delete" },
            resource: { type: "post", properties: ownPost },
          },
        ],
      }),
    );
    const result = await rows(response);
    expect(result.map((row) => [row.decision, row.context.outcome])).toEqual([
      [true, "granted"],
      [false, "denied"],
      [false, "denied"],
      [true, "granted"],
      [false, "denied"],
      [false, "denied"],
      [false, "denied"],
      [false, "denied"],
      [false, "approval-required"],
    ]);
    expect(result[8]?.context.permdock).toMatchObject({
      token: expect.any(String),
    });
    expect(result[4]?.context.permdock).toMatchObject({
      denials: [{ role: null, reason: "no-grant" }],
    });
  });

  it.each<[string | undefined, readonly boolean[]]>([
    [undefined, [true, false, true]],
    ["execute_all", [true, false, true]],
    ["deny_on_first_deny", [true, false]],
    ["permit_on_first_permit", [true]],
  ])("evaluates under evaluations_semantic %s", async (semantic, decisions) => {
    const response = await handler().POST(
      post({
        ...(semantic === undefined
          ? {}
          : { options: { evaluations_semantic: semantic } }),
        evaluations: [
          {
            action: { name: "post.update" },
            resource: { properties: ownPost },
          },
          {
            action: { name: "post.update" },
            resource: { properties: otherPost },
          },
          { action: { name: "post.read" }, resource: { properties: ownPost } },
        ],
      }),
    );
    expect((await rows(response)).map((row) => row.decision)).toEqual(
      decisions,
    );
  });

  it("refuses an unknown evaluations_semantic and echoes X-Request-ID", async () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "x-request-id": "req-9" },
      body: JSON.stringify({
        options: { evaluations_semantic: "first" },
        evaluations: [],
      }),
    });
    const response = await handler().POST(request);
    expect([response.status, response.headers.get("x-request-id")]).toEqual([
      400,
      "req-9",
    ]);
  });

  it("gives a denial reason_admin and reason_user", async () => {
    const [row] = await rows(
      await handler().POST(
        post({
          evaluations: [
            {
              action: { name: "post.update" },
              resource: { properties: otherPost },
            },
          ],
        }),
      ),
    );
    expect(row?.context).toMatchObject({
      reason_user: { en: "post.update is not permitted." },
    });
  });

  it("answers the signature problem when resolving the instance rejects it", async () => {
    const problem = invalidSignatureProblem("bad signature");
    const response = await handler({
      resolve: () => Promise.reject(new InvalidSignatureError(problem)),
    }).POST(post({ evaluations: [] }));
    expect(response).toBe(problem);
    await expect(
      handler({ resolve: () => Promise.reject(new Error("boom")) }).POST(
        post({ evaluations: [] }),
      ),
    ).rejects.toThrow("boom");
  });

  it("uses getPermDock when no resolver is given and fails without either", async () => {
    const getPermDock = vi.fn<
      (query?: { readonly tenant?: string }) => Promise<PermDock>
    >(async (): Promise<PermDock> => createCorePermDock(policy, memberUser));
    const viaGet = evaluationsHandler({ policy, getPermDock });
    expect((await viaGet.POST(post({ evaluations: [] }))).status).toBe(200);
    expect(getPermDock).toHaveBeenCalledWith(undefined);
    await expect(
      evaluationsHandler({ policy }).POST(post({ evaluations: [] })),
    ).rejects.toThrow(TypeError);
  });
});

describe("evaluationsHandler GET", () => {
  it("serves AuthZEN discovery for the origin", async () => {
    const response = await handler().GET(
      new Request("https://api.example/.well-known/authzen-configuration"),
    );
    expect(await response.json()).toEqual({
      policy_decision_point: "https://api.example",
      access_evaluation_endpoint: "https://api.example/access/v1/evaluation",
      access_evaluations_endpoint: "https://api.example/access/v1/evaluations",
    });
  });

  it("serves the snapshot, scoped to the requested tenant", async () => {
    const tenants: (string | undefined)[] = [];
    const resolve = async (): Promise<PermDock> => {
      const permdock = createCorePermDock(policy, memberUser);
      return {
        ...permdock,
        tenant: (id: string) => {
          tenants.push(id);
          return permdock;
        },
      };
    };
    const response = await handler({ resolve }).GET(
      new Request("https://api.example/permdock/snapshot?tenant=o1"),
    );
    expect(await response.json()).toMatchObject({ v: 1 });
    expect(tenants).toEqual(["o1"]);
    const getPermDock = vi.fn<
      (query?: { readonly tenant?: string }) => Promise<PermDock>
    >(async (): Promise<PermDock> => createCorePermDock(policy, memberUser));
    await evaluationsHandler({ policy, getPermDock }).GET(
      new Request("https://api.example/snapshot?tenant=o2"),
    );
    expect(getPermDock).toHaveBeenCalledWith({ tenant: "o2" });
  });

  it("answers the signature problem and rethrows other failures", async () => {
    const problem = invalidSignatureProblem("bad");
    expect(
      await handler({
        resolve: () => Promise.reject(new InvalidSignatureError(problem)),
      }).GET(new Request("https://api.example/snapshot")),
    ).toBe(problem);
    await expect(
      handler({ resolve: () => Promise.reject(new Error("down")) }).GET(
        new Request("https://api.example/snapshot"),
      ),
    ).rejects.toThrow("down");
  });
});
