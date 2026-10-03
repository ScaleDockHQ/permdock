import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Subject } from "../../src/core/subject.ts";
import type { RemotePdpOptions } from "../../src/pdp/types.ts";

import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { createPermDock, remotePdp } from "../../src/pdp/index.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
  tag: resource(z.object({ name: z.string() }), {
    id: "name",
    actions: ["read"],
  }),
});

const subject: Subject = {
  principal: { id: "u1", roles: ["member"], tenant: "acme" },
  context: {},
};

const anonymous: Subject = { principal: null, context: {} };

const evaluation = "https://pdp.test/access/v1/evaluation";

const post = { id: "p1" };

function decideWith(options: RemotePdpOptions, data: unknown = post) {
  const provider = remotePdp(options);
  return provider.decide({
    permission: permissions.post.read,
    data,
    subject,
    local: { outcome: "denied", denials: [], alternatives: [] },
  });
}

function bodyOf(raw: string): Record<string, unknown> {
  // SAFETY: remotePdp posts a JSON object body on every request.
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("remotePdp discovery", () => {
  it("reads every advertised endpoint from the AuthZEN configuration", async () => {
    const fake = fakeFetch((call) => {
      if (call.url.endsWith("/.well-known/authzen-configuration")) {
        return json({
          access_evaluation_endpoint: "https://eval.test/evaluate",
          access_evaluations_endpoint: "https://eval.test/batch",
          search_resource_endpoint: "https://eval.test/search",
        });
      }
      if (call.url === "https://eval.test/evaluate") {
        return json({ decision: true });
      }
      if (call.url === "https://eval.test/search") {
        return json({ results: [{ type: "post", id: "p9" }] });
      }
      return undefined;
    });
    const provider = remotePdp({ url: "https://pdp.test", fetch: fake.fetch });
    const decision = await provider.decide({
      permission: permissions.post.read,
      data: { id: "p1" },
      subject,
      local: { outcome: "denied", denials: [], alternatives: [] },
    });
    expect(decision.outcome).toBe("granted");
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toEqual(["p9"]);
    expect(
      fake.calls.filter((call) => call.url.includes(".well-known")).length,
    ).toBe(1);
  });

  it("joins the default path onto policy_decision_point", async () => {
    const fake = fakeFetch((call) =>
      call.url.includes(".well-known")
        ? json({ policy_decision_point: "https://other.test/" })
        : json({ decision: true }),
    );
    await decideWith({ url: "https://pdp.test", fetch: fake.fetch });
    expect(fake.calls[1]?.url).toBe("https://other.test/access/v1/evaluation");
  });

  it("falls back to the default path on the configured url", async () => {
    const fake = fakeFetch((call) =>
      call.url.includes(".well-known") ? json({}) : json({ decision: true }),
    );
    const provider = remotePdp({ url: "https://pdp.test", fetch: fake.fetch });
    await provider.decide({
      permission: permissions.post.read,
      data: { id: "p1" },
      subject,
      local: { outcome: "denied", denials: [], alternatives: [] },
    });
    expect(fake.calls[1]?.url).toBe(evaluation);
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toBeUndefined();
  });

  it("denies with pdp-unavailable for a missing, broken or non-object discovery document", async () => {
    const replies: readonly (() => Response)[] = [
      () => json({}, 404),
      () => new Response("not json", { status: 200 }),
      () => json(["not", "an", "object"]),
    ];
    for (const reply of replies) {
      const fake = fakeFetch(reply);
      const provider = remotePdp({
        url: "https://pdp.test",
        fetch: fake.fetch,
      });
      const decision = await provider.decide({
        permission: permissions.post.read,
        data: { id: "p1" },
        subject,
        local: { outcome: "denied", denials: [], alternatives: [] },
      });
      expect(reasonOf(decision)).toBe("pdp-unavailable");
      expect(
        await provider.permitted?.({
          permission: permissions.post.read,
          subject,
        }),
      ).toBeNull();
    }
  });
});

describe("remotePdp decide", () => {
  it("denies an anonymous subject without a request", async () => {
    const fake = fakeFetch(() => json({ decision: true }));
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation },
      fetch: fake.fetch,
    });
    const decision = await provider.decide({
      permission: permissions.post.read,
      data: { id: "p1" },
      subject: anonymous,
      local: { outcome: "denied", denials: [], alternatives: [] },
    });
    expect({ reason: reasonOf(decision), calls: fake.calls.length }).toEqual({
      reason: "anonymous",
      calls: 0,
    });
  });

  it("sends the default AuthZEN mapping with actor and delegation", async () => {
    const fake = fakeFetch(() => json({ decision: true }));
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation },
      fetch: fake.fetch,
    });
    await provider.decide({
      permission: permissions.post.read,
      data: { id: 7 },
      subject: {
        ...subject,
        actor: { id: "agent-1", kind: "mcp-client" },
        delegation: { scopes: ["post:read"] },
      },
      local: { outcome: "denied", denials: [], alternatives: [] },
    });
    expect(bodyOf(fake.calls[0]?.body ?? "{}")).toEqual({
      subject: {
        type: "user",
        id: "u1",
        properties: {
          orgId: "acme",
          roles: ["member"],
          actor: { id: "agent-1", kind: "mcp-client" },
          delegation: { scopes: ["post:read"] },
        },
      },
      action: { name: "read" },
      resource: { type: "post", id: "7", properties: { id: 7 } },
      context: {
        tenant: "acme",
        actor: { id: "agent-1", kind: "mcp-client" },
        delegation: { scopes: ["post:read"] },
      },
    });
  });

  it("uses the custom mapping and a resource id of * for non-object data", async () => {
    const fake = fakeFetch(() => json({ decision: true }));
    await decideWith(
      {
        url: "https://pdp.test",
        endpoints: { evaluation },
        fetch: fake.fetch,
        mapping: {
          subject: (s) => ({ type: "account", id: s.principal?.id ?? "" }),
          action: (permission) => ({ name: `can_${permission.action}` }),
        },
      },
      "not-an-object",
    );
    const body = bodyOf(fake.calls[0]?.body ?? "{}");
    expect({
      subject: body["subject"],
      action: body["action"],
      resource: body["resource"],
    }).toEqual({
      subject: { type: "account", id: "u1" },
      action: { name: "can_read" },
      resource: { type: "post", id: "*", properties: "not-an-object" },
    });
  });

  it("denies with pdp-invalid-response and sends nothing when a mapping throws", async () => {
    const fake = fakeFetch(() => json({ decision: true }));
    const decision = await decideWith({
      url: "https://pdp.test",
      endpoints: { evaluation },
      fetch: fake.fetch,
      mapping: {
        resource: () => {
          throw new Error("boom");
        },
      },
    });
    expect({ reason: reasonOf(decision), calls: fake.calls.length }).toEqual({
      reason: "pdp-invalid-response",
      calls: 0,
    });
  });

  it("sends the bearer token from a string or a function", async () => {
    for (const bearer of ["static", () => "dynamic", async () => "async"]) {
      const fake = fakeFetch(() => json({ decision: true }));
      await decideWith({
        url: "https://pdp.test",
        endpoints: { evaluation },
        fetch: fake.fetch,
        auth: { bearer },
      });
      expect(fake.calls[0]?.headers.get("authorization")).toMatch(
        /^Bearer (static|dynamic|async)$/u,
      );
    }
  });

  it("sends no authorization header for an empty or throwing bearer", async () => {
    const bearers: readonly (string | (() => string))[] = [
      "",
      () => {
        throw new Error("no token");
      },
    ];
    for (const bearer of bearers) {
      const fake = fakeFetch(() => json({ decision: true }));
      const decision = await decideWith({
        url: "https://pdp.test",
        endpoints: { evaluation },
        fetch: fake.fetch,
        auth: { bearer },
      });
      expect({
        outcome: decision.outcome,
        authorization: fake.calls[0]?.headers.get("authorization"),
      }).toEqual({ outcome: "granted", authorization: null });
    }
  });

  it("denies with pdp-unavailable when the body is not JSON", async () => {
    const decision = await decideWith({
      url: "https://pdp.test",
      endpoints: { evaluation },
      fetch: async () => new Response("<html>", { status: 200 }),
    });
    expect(reasonOf(decision)).toBe("pdp-unavailable");
  });

  it("maps the remote response table", async () => {
    const cases: readonly {
      readonly label: string;
      readonly body: unknown;
      readonly expected: unknown;
    }[] = [
      {
        label: "non-boolean decision",
        body: { decision: "yes" },
        expected: { outcome: "denied", reason: "pdp-invalid-response" },
      },
      {
        label: "not an object",
        body: [true],
        expected: { outcome: "denied", reason: "pdp-invalid-response" },
      },
      {
        label: "false without context",
        body: { decision: false },
        expected: { outcome: "denied", reason: "pdp-denied" },
      },
      {
        label: "approval without a token",
        body: {
          decision: false,
          context: { permdock: { outcome: "approval-required" } },
        },
        expected: { outcome: "approval-required", token: "" },
      },
      {
        label: "copied denials",
        body: {
          decision: false,
          context: {
            permdock: {
              denials: [
                { reason: "no-grant", role: "viewer", detail: "x" },
                { reason: "limit" },
                { role: "ignored" },
                "ignored",
              ],
            },
          },
        },
        expected: {
          outcome: "denied",
          denials: [
            { reason: "no-grant", role: "viewer", detail: "x" },
            { reason: "limit", role: null },
          ],
        },
      },
      {
        label: "only malformed denials",
        body: {
          decision: false,
          context: { permdock: { denials: [{ role: "x" }] } },
        },
        expected: { outcome: "denied", reason: "pdp-denied" },
      },
      {
        label: "context without permdock",
        body: { decision: false, context: { other: true } },
        expected: { outcome: "denied", reason: "pdp-denied" },
      },
    ];
    for (const item of cases) {
      const decision = await decideWith({
        url: "https://pdp.test",
        endpoints: { evaluation },
        fetch: async () => json(item.body),
      });
      // SAFETY: every row's expected value is an object literal.
      const actual =
        decision.outcome === "denied"
          ? "denials" in (item.expected as object)
            ? { outcome: "denied", denials: decision.denials }
            : { outcome: "denied", reason: reasonOf(decision) }
          : decision.outcome === "approval-required"
            ? { outcome: decision.outcome, token: decision.token }
            : { outcome: decision.outcome };
      expect({ label: item.label, actual }).toEqual({
        label: item.label,
        actual: item.expected,
      });
    }
  });

  it("caches approvals but never unavailability or copied denials", async () => {
    const replies = [
      () => json({}, 503),
      () =>
        json({
          decision: false,
          context: { permdock: { denials: [{ reason: "limit" }] } },
        }),
      () =>
        json({
          decision: false,
          context: { permdock: { outcome: "approval-required", token: "t" } },
        }),
    ];
    let index = 0;
    const fake = fakeFetch(() => {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply?.();
    });
    const options = {
      url: "https://pdp.test",
      endpoints: { evaluation },
      cache: { ttl: "500ms" },
      fetch: fake.fetch,
    } as const;
    const provider = remotePdp(options);
    const request = {
      permission: permissions.post.read,
      data: { id: "p1" },
      subject,
      local: { outcome: "denied", denials: [], alternatives: [] },
    } as const;
    const outcomes = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const decision = await provider.decide(request);
      outcomes.push(reasonOf(decision) ?? decision.outcome);
    }
    expect({ outcomes, calls: fake.calls.length }).toEqual({
      outcomes: [
        "pdp-unavailable",
        "limit",
        "approval-required",
        "approval-required",
      ],
      calls: 3,
    });
  });

  it("only delegates the listed permissions", () => {
    const provider = remotePdp({
      url: "https://pdp.test",
      permissions: [permissions.tag],
    });
    expect({
      tag: provider.handles(permissions.tag.read),
      post: provider.handles(permissions.post.read),
    }).toEqual({ tag: true, post: false });
  });
});

describe("remotePdp permitted", () => {
  const searchResource = "https://pdp.test/access/v1/search/resource";

  it("lists nothing for an anonymous subject", async () => {
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation, searchResource },
      fetch: async () => json({ results: [] }),
    });
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject: anonymous,
      }),
    ).toEqual([]);
  });

  it("returns undefined without a search endpoint", async () => {
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation },
    });
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toBeUndefined();
  });

  it("fails the listing when a mapping throws", async () => {
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation, searchResource },
      fetch: async () => json({ results: [] }),
      mapping: {
        subject: () => {
          throw new Error("boom");
        },
      },
    });
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toBeNull();
  });

  it("searches by the mapped resource type and caches the list", async () => {
    const fake = fakeFetch(() =>
      json({
        results: [{ type: "article", id: "a1" }],
        page: { next_token: "" },
      }),
    );
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation, searchResource },
      cache: { ttl: 1000 },
      fetch: fake.fetch,
      mapping: { resource: () => ({ type: "article" }) },
    });
    const request = { permission: permissions.post.read, subject };
    expect(await provider.permitted?.(request)).toEqual(["a1"]);
    expect(await provider.permitted?.(request)).toEqual(["a1"]);
    expect({
      calls: fake.calls.length,
      resource: bodyOf(fake.calls[0]?.body ?? "{}")["resource"],
    }).toEqual({ calls: 1, resource: { type: "article" } });
  });

  it("falls back to the permission resource when the mapped resource has no type", async () => {
    const fake = fakeFetch(() =>
      json({ results: [{ type: "post", id: "p1" }] }),
    );
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation, searchResource },
      fetch: fake.fetch,
      mapping: { resource: () => ({ id: "ignored" }) },
    });
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toEqual(["p1"]);
  });

  it("fails the listing for every malformed page", async () => {
    const pages: readonly unknown[] = [
      { results: "nope" },
      "nope",
      { results: ["p1"] },
      { results: [{ type: "post", id: 1 }] },
      { results: [{ type: "other", id: "p1" }] },
    ];
    for (const page of pages) {
      const provider = remotePdp({
        url: "https://pdp.test",
        endpoints: { evaluation, searchResource },
        fetch: async () => json(page),
      });
      expect({
        page,
        ids: await provider.permitted?.({
          permission: permissions.post.read,
          subject,
        }),
      }).toEqual({ page, ids: null });
    }
  });

  it("fails the listing on a network error or a non-2xx page", async () => {
    for (const fetcher of [
      async () => json({}, 500),
      async () => {
        throw new Error("down");
      },
    ]) {
      const provider = remotePdp({
        url: "https://pdp.test",
        endpoints: { evaluation, searchResource },
        fetch: fetcher,
      });
      expect(
        await provider.permitted?.({
          permission: permissions.post.read,
          subject,
        }),
      ).toBeNull();
    }
  });

  it("stops after 100 pages and fails the listing", async () => {
    const fake = fakeFetch(() =>
      json({
        results: [{ type: "post", id: "p" }],
        page: { next_token: "more" },
      }),
    );
    const provider = remotePdp({
      url: "https://pdp.test",
      endpoints: { evaluation, searchResource },
      fetch: fake.fetch,
    });
    expect(
      await provider.permitted?.({
        permission: permissions.post.read,
        subject,
      }),
    ).toBeNull();
    expect(fake.calls.length).toBe(100);
  });
});

describe("remotePdp through createPermDock", () => {
  it("denies a delegated permission when the PDP is down", async () => {
    const policy = definePolicy(permissions, {
      roles: [role("member", [allow(permissions.post.read)])],
      subject: (user: { readonly id: string }) => ({
        id: user.id,
        roles: ["member"],
      }),
      providers: [
        remotePdp({
          url: "https://pdp.test",
          fetch: async () => {
            throw new Error("down");
          },
        }),
      ],
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(
      reasonOf(await permdock.decide(permissions.post.read, { id: "p1" })),
    ).toBe("pdp-unavailable");
  });
});
