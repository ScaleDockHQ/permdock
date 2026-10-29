import type { Approvals } from "better-supabase/blocks/approvals";

import { describe, expectTypeOf, it } from "vitest";

import type { ApprovalStore } from "../../src/approvals/types.ts";
import type { ApprovalPolicySource } from "../../src/core/approval-policies.ts";

import {
  blockApprovalPolicySource,
  blockApprovalStore,
} from "../../src/better-supabase/index.ts";

declare const approvals: Approvals;

describe("approvals block bridges", () => {
  it("take createApprovals(...) as it is", () => {
    expectTypeOf(blockApprovalStore(approvals)).toEqualTypeOf<ApprovalStore>();
    expectTypeOf(
      blockApprovalPolicySource(approvals),
    ).toEqualTypeOf<ApprovalPolicySource>();
  });
});
