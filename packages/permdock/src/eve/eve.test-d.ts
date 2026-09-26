import type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalResponseContext,
} from 'eve/tools/approval';

import { describe, expectTypeOf, it } from 'vitest';

import { ownPost, permissions, policy } from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

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
    expectTypeOf(approval.request).toBeCallableWith({} as ApprovalContext);
    expectTypeOf(approval.response).toBeCallableWith(
      {} as ApprovalResponseContext,
    );
  });
});
