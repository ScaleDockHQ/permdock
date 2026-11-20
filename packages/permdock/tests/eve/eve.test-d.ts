import type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalResponseContext,
} from "eve/tools/approval";

import { describe, expectTypeOf, it } from "vitest";

import type {
  EveApprovalContext,
  EveResponseContext,
} from "../../src/eve/index.ts";

import { createPermDock } from "../../src/eve/index.ts";
import { ownPost, permissions, policy } from "../fixtures/quick-start.ts";

const { approval, approvalFor } = createPermDock(policy, {
  operations: { delete_post: { permission: permissions.post.delete } },
});

describe("permdock/eve against eve", () => {
  it("returns an eve Approval with request and response policies", () => {
    expectTypeOf(approval).toExtend<Approval>();
    expectTypeOf(approval).toExtend<ApprovalConfiguration>();
    expectTypeOf(
      approvalFor(permissions.post.delete, () => ownPost),
    ).toExtend<ApprovalConfiguration>();
  });

  it("takes the single eve context on each side", () => {
    // SAFETY: type-level placeholder; toBeCallableWith checks the type and never calls request.
    expectTypeOf(approval.request).toBeCallableWith({} as ApprovalContext);
    // SAFETY: type-level placeholder; toBeCallableWith checks the type and never calls response.
    expectTypeOf(approval.response).toBeCallableWith(
      {} as ApprovalResponseContext,
    );
  });
});

describe("permdock/eve context shapes against eve", () => {
  it("keeps the request, response and session keys of eve's response context", () => {
    // The adapter never reads `auth`, so the structural type leaves it out.
    expectTypeOf<keyof EveResponseContext>().toEqualTypeOf<
      Exclude<keyof ApprovalResponseContext, "auth">
    >();
    expectTypeOf<keyof EveResponseContext["request"]>().toEqualTypeOf<
      keyof ApprovalResponseContext["request"]
    >();
    expectTypeOf<keyof EveResponseContext["response"]>().toEqualTypeOf<
      keyof ApprovalResponseContext["response"]
    >();
    expectTypeOf<keyof EveResponseContext["session"]>().toEqualTypeOf<
      keyof ApprovalResponseContext["session"]
    >();
    expectTypeOf<EveResponseContext["response"]["decision"]>().toEqualTypeOf<
      ApprovalResponseContext["response"]["decision"]
    >();
  });

  it("accepts eve's response and approval contexts", () => {
    expectTypeOf<ApprovalResponseContext>().toExtend<EveResponseContext>();
    expectTypeOf<ApprovalContext>().toExtend<EveApprovalContext>();
  });

  it("reads only keys eve's approval context has", () => {
    expectTypeOf<keyof EveApprovalContext>().toExtend<keyof ApprovalContext>();
  });
});
