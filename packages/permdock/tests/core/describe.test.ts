import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { Grantee } from "../../src/core/grantee.ts";

import { describe as describeDecision } from "../../src/core/describe.ts";

function approval(by: Grantee | readonly Grantee[]): Decision {
  return {
    outcome: "approval-required",
    grant: {
      role: "member",
      permission: "post.delete",
      to: { kind: "role", role: "member", scope: "global" },
      approval: { by },
    },
    reason: "human",
    token: "pd1.x",
  };
}

function denied(...reasons: readonly string[]): Decision {
  // SAFETY: the reasons below are members of the closed DenialReason list.
  return {
    outcome: "denied",
    denials: reasons.map((reason) => ({ role: null, reason })),
    alternatives: [],
  } as Decision;
}

describe("describe", () => {
  it.each<[Grantee | readonly Grantee[], string]>([
    [{ kind: "role", role: "admin", scope: "global" }, "admin"],
    [{ kind: "plan", plan: "pro" }, "pro"],
    [{ kind: "actor", actor: "agent" }, "agent"],
    [{ kind: "authenticated" }, "an authenticated user"],
    [{ kind: "anyone" }, "anyone"],
    [{ kind: "relation", resource: "doc", relation: "owner" }, "owner"],
    [
      { kind: "assurance", acr: ["aal2"], amr: ["hwk", "pin"] },
      "acr aal2 amr hwk/pin",
    ],
    [{ kind: "assurance", acr: [], amr: [] }, "step-up"],
    [{ kind: "assurance" }, "step-up"],
    [
      [
        { kind: "role", role: "admin", scope: "global" },
        { kind: "plan", plan: "pro" },
      ],
      "admin and pro",
    ],
  ])("names the approver %j", (by, label) => {
    expect(describeDecision(approval(by))).toEqual({
      kind: "approval",
      title: "Approval required",
      detail: `post.delete requires approval from ${label}.`,
      alternatives: [],
    });
  });

  it.each([
    [["tenant-mismatch", "no-grant"], "tenant", "Wrong tenant"],
    [["not-delegated"], "delegation", "Not delegated"],
    [["opaque-condition"], "server-only", "Server only"],
    [["server-only"], "server-only", "Server only"],
    [["no-grant", "condition"], "denied", "Denied"],
  ] as const)("classifies %j as %s", (reasons, kind, title) => {
    expect(describeDecision(denied(...reasons))).toEqual({
      kind,
      title,
      detail: reasons.join(", "),
      alternatives: [],
    });
  });

  it("passes each reason and the decision to a reasons function", () => {
    const decision = denied("no-grant", "condition", "tenant-mismatch");
    const seen: unknown[] = [];
    const result = describeDecision(decision, {
      messages: {
        reasons: (reason, full) => {
          seen.push(full);
          return reason === "no-grant"
            ? `geen toegang (${String(full.denials.length)})`
            : undefined;
        },
      },
    });
    expect(result.detail).toBe("geen toegang (3), condition, tenant-mismatch");
    expect(seen).toEqual([decision, decision, decision]);
  });

  it("uses a message table and falls back to English per entry", () => {
    const messages = {
      titles: { denied: "Geweigerd", approval: "Goedkeuring nodig" },
      reasons: { "no-grant": "geen toegang" },
      separator: "; ",
      granted: (permission: string) => `${permission} toegestaan`,
      approval: (permission: string, by: readonly string[]) =>
        `${permission}: ${by.length === 0 ? "een mens" : by.join(", ")}`,
      upgrade: (plans: readonly string[]) => `plan ${plans.join("/")}`,
    };
    expect(
      describeDecision(denied("no-grant", "condition"), { messages }),
    ).toEqual({
      kind: "denied",
      title: "Geweigerd",
      detail: "geen toegang; condition",
      alternatives: [],
    });
    expect(
      describeDecision(denied("tenant-mismatch"), { messages }).title,
    ).toBe("Wrong tenant");
    expect(
      describeDecision(
        approval({ kind: "role", role: "admin", scope: "global" }),
        { messages },
      ),
    ).toMatchObject({
      title: "Goedkeuring nodig",
      detail: "post.delete: admin",
    });
    const granted: Decision = {
      outcome: "granted",
      subject: { principal: { id: "u1" }, context: {} },
      token: "pd1.x",
      matched: {
        role: "admin",
        permission: "post.read",
        to: { kind: "role", role: "admin", scope: "global" },
      },
    };
    expect(describeDecision(granted, { messages }).detail).toBe(
      "post.read toegestaan",
    );
    const upgrade: Decision = {
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "not-entitled",
          to: { kind: "plan", plan: "pro" },
        },
      ],
      alternatives: [],
    };
    expect(describeDecision(upgrade, { messages }).detail).toBe("plan pro");
  });
});
