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
});
