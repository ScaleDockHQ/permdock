import type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalResponseContext,
} from 'eve/tools/approval';

import { describe, expectTypeOf, it } from 'vitest';

import { createPermDock } from '../../src/eve/index.ts';
import { ownPost, permissions, policy } from '../fixtures/quick-start.ts';

const { approval, approvalFor } = createPermDock(policy, {
  tools: { delete_post: { permission: permissions.post.delete } },
});

describe('permdock/eve against eve', () => {
  it('returns an eve Approval with request and response policies', () => {
    expectTypeOf(approval).toExtend<Approval>();
    expectTypeOf(approval).toExtend<ApprovalConfiguration>();
    expectTypeOf(
      approvalFor(permissions.post.delete, () => ownPost),
    ).toExtend<ApprovalConfiguration>();
  });

  it('takes the single eve context on each side', () => {
    // SAFETY: type-level placeholder; toBeCallableWith checks the type and never calls request.
    expectTypeOf(approval.request).toBeCallableWith({} as ApprovalContext);
    // SAFETY: type-level placeholder; toBeCallableWith checks the type and never calls response.
    expectTypeOf(approval.response).toBeCallableWith(
      {} as ApprovalResponseContext,
    );
  });
});
