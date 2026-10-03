import { describe, expect, it } from "vitest";

import type { DecisionEvent } from "../../src/core/interfaces.ts";

import { PermDockDeniedError } from "../../src/core/errors.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { wireDenial } from "../../src/core/wire-denial.ts";
import { isDecisionEvent } from "../fixtures/decisions.ts";
import { memberUser, ownPost, permissions } from "../fixtures/quick-start.ts";

describe("wireDenial", () => {
  it("keeps role, reason, to and a JSON detail", () => {
    const limit = { quota: "seats", used: 3, max: 3 };
    const to = { kind: "role", role: "user", scope: "global" } as const;
    expect(
      wireDenial({
        role: "member",
        reason: "limit",
        detail: limit,
        to,
      }),
    ).toEqual({ role: "member", reason: "limit", detail: limit, to });
    expect(
      wireDenial({ role: null, reason: "not-entitled", detail: "pro" }),
    ).toEqual({ role: null, reason: "not-entitled", detail: "pro" });
  });

  it("drops what a closure threw and validation errors", () => {
    const secret = { password: "hunter2" };
    expect(
      wireDenial({ role: "member", reason: "closure-error", detail: secret }),
    ).toEqual({ role: "member", reason: "closure-error" });
    expect(
      wireDenial({ role: null, reason: "validation", detail: new Error("x") }),
    ).toEqual({ role: null, reason: "validation" });
    expect(
      wireDenial({ role: null, reason: "condition", detail: new Error("x") }),
    ).toEqual({ role: null, reason: "condition" });
  });

  it("drops a detail that is not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(
      wireDenial({ role: null, reason: "condition", detail: cyclic }),
    ).toEqual({ role: null, reason: "condition" });
    expect(
      wireDenial({ role: null, reason: "condition", detail: () => 1 }),
    ).toEqual({ role: null, reason: "condition" });
  });
});

describe("outbound denials", () => {
  const secret = { password: "hunter2" };
  const throwing = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.post.read, () => {
          // oxlint-disable-next-line typescript/only-throw-error
          throw secret;
        }),
      ]),
    ],
    subject: () => ({ id: "u1", roles: ["member"] }),
  });

  it("keeps a thrown value out of the decision event", async () => {
    const permdock = await createPermDock(throwing, memberUser);
    permdock.on("error", () => undefined);
    const events: DecisionEvent[] = [];
    permdock.on("decision", (event) => {
      if (isDecisionEvent(event)) {
        events.push(event);
      }
    });
    const decision = permdock.decide(permissions.post.read, ownPost);
    expect(decision.outcome).toBe("denied");
    expect(events[0]?.denials).toEqual([
      { role: "member", reason: "closure-error" },
    ]);
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("keeps a thrown value out of the Problem Details body", async () => {
    const permdock = await createPermDock(throwing, memberUser);
    permdock.on("error", () => undefined);
    const decision = permdock.decide(permissions.post.read, ownPost);
    if (decision.outcome !== "denied") {
      throw new Error("expected a denial");
    }
    const error = new PermDockDeniedError({
      decision,
      permission: permissions.post.read.key,
      scope: permissions.post.read.scope,
      resource: { type: "post" },
      subject: permdock.subject,
      message: "denied",
    });
    expect(JSON.stringify(error.toProblemDetails())).not.toContain("hunter2");
  });
});

describe("wireDenial detail", () => {
  it.each([
    [3, 3],
    [Number.POSITIVE_INFINITY, undefined],
    [Number.NaN, undefined],
    [true, true],
    ["quota", "quota"],
    [null, undefined],
    [new Error("secret"), undefined],
    [10n, undefined],
    [
      {
        toJSON: () => {
          throw new Error("boom");
        },
      },
      undefined,
    ],
  ])("sends %o as %o", (detail, expected) => {
    expect(wireDenial({ role: null, reason: "limit", detail }).detail).toBe(
      expected,
    );
  });

  it("keeps closure errors and validation details in process", () => {
    expect(
      wireDenial({ role: null, reason: "validation", detail: "field x" }),
    ).toEqual({ role: null, reason: "validation" });
  });
});
