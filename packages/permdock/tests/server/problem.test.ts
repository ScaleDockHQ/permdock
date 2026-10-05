import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Principal, Subject } from "../../src/core/subject.ts";

import { memoryLimitStore } from "../../src/core/limits.ts";
import { createPermDock as createCorePermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import {
  allow,
  assurance,
  breakGlass,
  definePolicy,
  deny,
  principal,
  role,
} from "../../src/index.ts";
import { createPermDock } from "../../src/server/index.ts";
import {
  rateLimitHeaders,
  stepUpOf,
  wwwAuthenticate,
} from "../../src/server/problem.ts";

const Report = z.object({ id: z.string(), ownerId: z.string() });

type User = {
  readonly id: string;
  readonly roles: readonly string[];
  readonly authTime?: number;
};

function permissionsWith(disclosure?: "hide" | "reveal") {
  return definePermissions({
    report: resource(Report, {
      actions: ["read", "export"],
      ...(disclosure === undefined ? {} : { disclosure }),
    }),
  });
}

const request = (): Request => new Request("https://api.example/reports/r1");

describe("rate limit responses", () => {
  const permissions = permissionsWith();
  const policy = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.report.export, { limit: { count: 2, per: "hour" } }),
      ]),
    ],
    subject: (user: User) => user,
  });

  it("answers an exhausted limit with 429 and the RateLimit fields", async () => {
    const { protect } = createPermDock(policy, {
      subject: () => ({ id: "u1", roles: ["member"] }),
      limits: memoryLimitStore(),
    });
    const guard = protect(permissions.report.export);
    expect((await guard(request())).ok).toBe(true);
    expect((await guard(request())).ok).toBe(true);
    const refused = await guard(request());
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    const { response } = refused;
    expect(response.status).toBe(429);
    const wait = Number(response.headers.get("Retry-After"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(response.headers.get("RateLimit")).toBe(`"member";r=0;t=${wait}`);
    expect(response.headers.get("RateLimit-Policy")).toBe(
      '"member";q=2;w=3600',
    );
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toMatchObject({
      type: "https://permdock.com/problems/rate-limited",
      status: 429,
      denials: [{ role: "member", reason: "limit" }],
    });
  });

  it("answers a missing limit store with 503", async () => {
    const { protect } = createPermDock(policy, {
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const refused = await protect(permissions.report.export)(request());
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.response.status).toBe(503);
    expect(refused.response.headers.get("Retry-After")).toBeNull();
    expect(await refused.response.json()).toMatchObject({
      type: "https://permdock.com/problems/limit-unavailable",
      denials: [{ reason: "limit-unavailable" }],
    });
  });

  it("takes the earliest reset across exhausted grants", () => {
    const headers = rateLimitHeaders(
      {
        outcome: "denied",
        denials: [
          {
            role: "a",
            reason: "limit",
            detail: { count: 5, window: 60, resetsAt: 1030 },
          },
          {
            role: "b",
            reason: "limit",
            detail: { count: 100, window: 3600, resetsAt: 1500 },
          },
          { role: "c", reason: "limit", detail: { count: "x" } },
        ],
        alternatives: [],
      },
      1000,
    );
    expect(headers).toEqual({
      "Retry-After": "30",
      RateLimit: '"a";r=0;t=30, "b";r=0;t=500',
      "RateLimit-Policy": '"a";q=5;w=60, "b";q=100;w=3600',
    });
  });
});

describe("disclosure", () => {
  function kernel(disclosure?: "hide" | "reveal") {
    const permissions = permissionsWith(disclosure);
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.report.read, {
            where: { ownerId: principal.id },
          }),
          allow(permissions.report.export, {
            where: { ownerId: principal.id },
            to: assurance({ acr: "mfa" }),
          }),
        ]),
      ],
      subject: (user: User) => user,
    });
    return {
      permissions,
      permdock: createPermDock(policy, {
        subject: (req) =>
          req.headers.has("anonymous") ? null : { id: "u1", roles: ["member"] },
      }),
    };
  }

  it("answers a denied row of a hidden resource like a missing one", async () => {
    const { permissions, permdock } = kernel("hide");
    const theirs = await permdock.protect(permissions.report.read, () => ({
      id: "r2",
      ownerId: "u2",
    }))(request());
    const missing = await permdock.protect(
      permissions.report.read,
      () => null,
    )(request());
    const anonymous = await permdock.protect(permissions.report.read, () => ({
      id: "r1",
      ownerId: "u1",
    }))(
      new Request("https://api.example/reports/r1", {
        headers: { anonymous: "1" },
      }),
    );
    expect(theirs.ok || missing.ok || anonymous.ok).toBe(false);
    if (theirs.ok || missing.ok || anonymous.ok) {
      return;
    }
    const bodies = await Promise.all(
      [theirs, missing, anonymous].map(async ({ response }) => ({
        status: response.status,
        challenge: response.headers.get("WWW-Authenticate"),
        body: await response.text(),
      })),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2]).toEqual(bodies[1]);
    expect(bodies[1]?.status).toBe(404);
    expect(JSON.parse(bodies[1]?.body ?? "{}")).toMatchObject({
      type: "https://permdock.com/problems/not-found",
    });
  });

  it("still asks the grant holder of a hidden row to step up", async () => {
    const { permissions, permdock } = kernel("hide");
    const own = await permdock.protect(permissions.report.export, () => ({
      id: "r1",
      ownerId: "u1",
    }))(request());
    expect(own.ok).toBe(false);
    if (!own.ok) {
      expect(own.response.status).toBe(401);
    }
  });

  it("keeps the 403 on a revealed resource", async () => {
    const { permissions, permdock } = kernel();
    const theirs = await permdock.protect(permissions.report.read, () => ({
      id: "r2",
      ownerId: "u2",
    }))(request());
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) {
      expect(theirs.response.status).toBe(403);
    }
  });

  it("rejects an unknown disclosure", () => {
    // SAFETY: deliberately invalid disclosure to exercise definePermissions validation.
    expect(() =>
      definePermissions({
        report: resource(Report, {
          actions: ["read"],
          disclosure: "maybe" as "hide",
        }),
      }),
    ).toThrow(/disclosure/u);
  });
});

describe("step-up challenges", () => {
  const permissions = permissionsWith();

  it("names acr_values and max_age in the header and the body", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.report.read, {
            to: assurance({ acr: ["mfa", "phr"], maxAge: 600 }),
          }),
          allow(permissions.report.read, {
            to: assurance({ acr: "mfa", maxAge: 300 }),
          }),
        ]),
      ],
      subject: (user: User) => user,
    });
    const { protect } = createPermDock(policy, {
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const refused = await protect(permissions.report.read)(request());
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.response.status).toBe(401);
    expect(refused.response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa phr", max_age="300"',
    );
    expect(await refused.response.json()).toMatchObject({
      type: "https://permdock.com/problems/step-up-required",
      acrValues: ["mfa", "phr"],
      maxAge: 300,
    });
  });

  it("carries break-glass and activation assurance requirements", async () => {
    const policy = definePolicy(permissions, {
      scopes: { tenant: { key: "tenant_id" } },
      roles: [
        role("admin", [], {
          on: "tenant",
          activation: { assurance: { acr: ["mfa"], maxAge: 60 } },
        }),
      ],
      grants: [
        deny(permissions.report.read, {
          to: { kind: "anyone" },
          name: "frozen",
        }),
        breakGlass(permissions.report.read, {
          overrides: ["frozen"],
          requires: { purpose: ["incident"], assurance: { maxAge: 120 } },
        }),
      ],
      subject: (user: Subject | null) =>
        user === null ? null : user.principal,
    });
    const eligible: Principal = {
      id: "u1",
      memberships: [
        { scope: "tenant", id: "t1", roles: [], eligible: ["admin"] },
      ],
    };
    // SAFETY: the subject omits optional fields; the policy's user generic is erased to PermDock.
    const permdock = (await createCorePermDock(policy, {
      principal: eligible,
      context: { purpose: "incident" },
    } as Subject)) as PermDock;
    const glass = permdock.decide(permissions.report.read, {
      id: "r1",
      ownerId: "u1",
    });
    expect(glass.outcome).toBe("denied");
    expect(stepUpOf(glass)).toEqual({ maxAge: 120 });
    expect(wwwAuthenticate(glass, permissions.report.read)).toBe(
      'Bearer error="insufficient_user_authentication", max_age="120"',
    );
    const elevated = permdock.activate({
      role: "admin",
      scope: "tenant",
      id: "t1",
    });
    expect(stepUpOf(elevated)).toEqual({ acrValues: ["mfa"], maxAge: 60 });
  });
});
