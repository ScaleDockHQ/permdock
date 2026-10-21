import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/decision.ts";

import { gateView } from "../../src/client/views.ts";
import { describe as describeDecision } from "../../src/core/describe.ts";

// SAFETY: partial decisions; gateView reads outcome and passes them to describe and requiredPlans.
const granted = {
  outcome: "granted",
  matched: { permission: "post.update", role: "member" },
} as unknown as Decision;
// SAFETY: a partial denied decision; gateView reads its outcome and denials.
const denied = {
  outcome: "denied",
  denials: [{ role: "member", reason: "no-grant" }],
  alternatives: [],
} as unknown as Decision;
// SAFETY: a partial not-entitled decision; requiredPlans reads its denials.
const upgrade = {
  outcome: "denied",
  denials: [
    { role: null, reason: "not-entitled", to: { kind: "plan", plan: "pro" } },
  ],
  alternatives: [],
} as unknown as Decision;
// SAFETY: a partial approval-required decision; gateView reads its outcome.
const approval = {
  outcome: "approval-required",
  grant: { permission: "post.delete", role: "member", approval: "human" },
  token: "pd1.t",
} as unknown as Decision;

function view(
  decision: Decision,
  allowed: boolean,
  status: "ready" | "pending",
  mode?: "hide" | "disable",
) {
  return gateView(
    { allowed, status, decision },
    (item) => describeDecision(item),
    mode,
  );
}

describe(gateView, () => {
  it("enables a granted control", () => {
    expect(view(granted, true, "ready")).toMatchObject({
      allowed: true,
      disabled: false,
      hidden: false,
      needsApproval: false,
      upgrade: [],
    });
  });

  it("hides a denied control under hide and disables it under disable", () => {
    expect(view(denied, false, "ready", "hide")).toMatchObject({
      hidden: true,
      disabled: true,
    });
    expect(view(denied, false, "ready")).toMatchObject({
      hidden: false,
      disabled: true,
      reason: { kind: "denied" },
    });
  });

  it("keeps a pending or approval-required control visible and disabled", () => {
    expect(view(granted, true, "pending", "hide")).toMatchObject({
      allowed: false,
      pending: true,
      hidden: false,
      disabled: true,
    });
    expect(view(approval, false, "ready", "hide")).toMatchObject({
      hidden: false,
      disabled: true,
      needsApproval: true,
      reason: { kind: "approval" },
    });
  });

  it("names the plans that would grant an upgrade", () => {
    expect(view(upgrade, false, "ready")).toMatchObject({
      upgrade: ["pro"],
      reason: { kind: "upgrade" },
    });
  });
});
