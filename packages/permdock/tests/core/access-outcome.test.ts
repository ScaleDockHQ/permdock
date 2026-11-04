import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { Principal } from "../../src/core/subject.ts";

import { accessOutcome } from "../../src/core/access-outcome.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { permissions, personas, policy } from "../fixtures/named-scopes.ts";

const { tenant: _active, ...unscoped } = personas.owner;

const decide = (user: Principal | null, tenant?: string): Decision =>
  getPermDockSync(policy, user, tenant === undefined ? {} : { tenant }).decide(
    // SAFETY: a rowless check of an instance leaf is the type-level check under test.
    permissions.quote.read as never,
  );

describe(accessOutcome, () => {
  it("names a granted decision", () => {
    expect(accessOutcome(decide(personas.owner))).toBe("granted");
  });

  it("names an anonymous caller", () => {
    expect(accessOutcome(decide(null))).toBe("anonymous");
  });

  it("names a caller with no active tenant", () => {
    expect(accessOutcome(decide(unscoped))).toBe("no-tenant");
  });

  it("names a tenant the caller holds no membership in", () => {
    expect(accessOutcome(decide(personas.owner, "Z"))).toBe("no-membership");
  });

  it("names every other denial denied", () => {
    expect(accessOutcome(decide(personas.platformAdmin))).toBe("denied");
  });

  it("names a decision that waits for an approver", () => {
    const decision: Decision = {
      outcome: "approval-required",
      grant: { role: null, permission: "quote.read" },
      reason: "human",
      token: "t",
    };
    expect(accessOutcome(decision)).toBe("approval-required");
  });

  it("lets an explicit deny win over a missing membership", () => {
    const decision: Decision = {
      outcome: "denied",
      denials: [
        { role: null, reason: "no-membership" },
        { role: "viewer", reason: "deny" },
      ],
      alternatives: [],
    };
    expect(accessOutcome(decision)).toBe("denied");
  });
});
