import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { allow, definePolicy, role } from "../../src/index.ts";
import { createPermDock } from "../../src/server/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const request = (): Request => new Request("https://api.example/posts/p2");

function errorsOf(permdock: PermDock): unknown[] {
  const seen: unknown[] = [];
  permdock.on("error", (error) => {
    seen.push(error);
  });
  return seen;
}

describe("server onDenied", () => {
  it("replaces the refusal with the Problem Details it returns", async () => {
    const server = createPermDock(policy, {
      subject: () => memberUser,
      onDenied: ({ problem, decision }) => ({
        ...problem,
        detail: `custom: ${decision.outcome}`,
        code: "POST_LOCKED",
      }),
    });
    const guard = await server.protect(
      permissions.post.update,
      () => otherPost,
    )(request());
    expect(guard.ok).toBe(false);
    if (guard.ok) {
      return;
    }
    expect(guard.response.status).toBe(403);
    expect(guard.response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await guard.response.json()).toMatchObject({
      permission: "post.update",
      detail: "custom: denied",
      code: "POST_LOCKED",
    });
    expect(guard.decision?.outcome).toBe("denied");
  });

  it("returns a Response it builds as the refusal", async () => {
    const server = createPermDock(policy, {
      subject: () => memberUser,
      onDenied: () => Response.redirect("https://app.example/upgrade", 303),
    });
    const guard = await server.protect(
      permissions.post.update,
      () => otherPost,
    )(request());
    expect(guard.ok ? 0 : guard.response.status).toBe(303);
  });

  it.each<[string, () => unknown]>([
    ["a 200 Response", () => new Response("ok", { status: 200 })],
    [
      "Problem Details with status 204",
      () => ({ type: "x", title: "x", status: 204, detail: "x" }),
    ],
    [
      "a throw",
      () => {
        throw new Error("hook broke");
      },
    ],
  ])(
    "cannot grant: %s keeps the default refusal and reports it",
    async (_label, hook) => {
      const shared = request();
      const server = createPermDock(policy, {
        subject: () => memberUser,
        // SAFETY: the cases return values outside OnDenied's type on purpose.
        onDenied: hook as never,
      });
      const guard = await server.protect(
        permissions.post.update,
        () => otherPost,
      )(shared);
      expect(guard.ok).toBe(false);
      expect(guard.ok ? 0 : guard.response.status).toBe(403);
      const errors = errorsOf(await server.permdock(shared));
      expect(errors).toHaveLength(1);
    },
  );

  it("is never called for a granted request", async () => {
    let calls = 0;
    const server = createPermDock(policy, {
      subject: () => memberUser,
      onDenied: () => {
        calls += 1;
        return undefined;
      },
    });
    const guard = await server.protect(
      permissions.post.update,
      () => ownPost,
    )(request());
    expect(guard.ok).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("server protect", () => {
  it("fails closed with Problem Details when the loader throws, and reports it", async () => {
    const shared = request();
    const server = createPermDock(policy, { subject: () => memberUser });
    const guard = await server.protect(permissions.post.update, () => {
      throw new Error("database down");
    })(shared);
    expect(guard.ok).toBe(false);
    if (guard.ok) {
      return;
    }
    expect(guard.response.status).toBe(403);
    expect(await guard.response.json()).toMatchObject({
      detail: "post.update failed closed: the row could not be loaded",
    });
    expect(guard.decision?.outcome).toBe("denied");
    const errors = errorsOf(await server.permdock(shared));
    expect(errors).toEqual([new Error("database down")]);
  });

  it("adds the trace with explain", async () => {
    const server = createPermDock(policy, { subject: () => memberUser });
    const guard = await server.protect(permissions.post.update, () => ownPost, {
      explain: true,
    })(request());
    expect(guard.ok && guard.decision.trace !== undefined).toBe(true);
  });
});

describe("server context", () => {
  const permissionsOnly = definePolicy(permissions, {
    roles: [role("member", [allow(permissions.post.read)])],
    subject: (user: { id: string } | null) =>
      user === null ? null : { id: user.id, roles: ["member"] },
    context: () => ({ region: "eu" }),
  });

  it("merges request values into subject.context, under policy.context", async () => {
    const server = createPermDock(permissionsOnly, {
      subject: () => ({ id: "u1" }),
      context: (incoming) => ({
        region: "us",
        ip: incoming.headers.get("x-forwarded-for") ?? "unknown",
      }),
    });
    const permdock = await server.permdock(
      new Request("https://api.example/", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
    );
    expect(permdock.subject.context).toEqual({
      region: "eu",
      ip: "203.0.113.7",
    });
  });

  it.each<[string, () => unknown]>([
    [
      "a throw",
      () => {
        throw new Error("no geo");
      },
    ],
    ["a value that is not a JSON object", () => ({ at: new Date(0) })],
    ["an array", () => ["eu"]],
  ])("adds nothing for %s and reports it", async (_label, hook) => {
    const server = createPermDock(permissionsOnly, {
      subject: () => ({ id: "u1" }),
      // SAFETY: the cases return values outside the hook's type on purpose.
      context: hook as never,
    });
    const permdock = await server.permdock(request());
    expect(permdock.subject.context).toEqual({ region: "eu" });
    expect(errorsOf(permdock)).toHaveLength(1);
  });
});

describe("server wrap", () => {
  it("wraps each instance after it is built and keeps the error channel", async () => {
    const wrapped: string[] = [];
    const server = createPermDock(policy, {
      subject: () => memberUser,
      wrap: (permdock) => {
        wrapped.push("wrap");
        return permdock;
      },
    });
    const permdock = await server.permdock(request());
    expect(wrapped).toEqual(["wrap"]);
    expect(typeof permdock.on).toBe("function");
  });
});
