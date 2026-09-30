import { describe, expect, it } from 'vitest';

import {
  approvalDigest,
  deniedDigest,
  parsePermDockDigest,
} from '../../src/core/digest.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from '../../src/core/errors.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('PermDock error digests', () => {
  it('round-trips denied and approval-required digests', () => {
    expect(parsePermDockDigest(deniedDigest('post.update'))).toEqual({
      outcome: 'denied',
      permission: 'post.update',
    });
    expect(
      parsePermDockDigest(approvalDigest('post.delete', 'pd1.abc')),
    ).toEqual({
      outcome: 'approval-required',
      permission: 'post.delete',
      token: 'pd1.abc',
    });
  });

  it('rejects anything that is not a PermDock digest', () => {
    for (const digest of [
      undefined,
      42,
      '',
      'NEXT_HTTP_ERROR_FALLBACK;403',
      'PERMDOCK_DENIED',
      'PERMDOCK_DENIED;',
      'PERMDOCK_DENIED;post.update;extra',
      'PERMDOCK_APPROVAL_REQUIRED;post.delete',
      'PERMDOCK_APPROVAL_REQUIRED;post.delete;',
      'PERMDOCK_APPROVAL_REQUIRED;post.delete;pd1.abc;extra',
      '1234567890',
    ]) {
      expect(parsePermDockDigest(digest)).toBeNull();
    }
  });

  it('stamps a stable digest on the errors assert throws', async () => {
    const member = await createPermDock(policy, memberUser);
    const denied = thrown(() =>
      member.assert(permissions.post.update, otherPost),
    );
    expect(denied).toBeInstanceOf(PermDockDeniedError);
    // SAFETY: checked by toBeInstanceOf above.
    expect((denied as PermDockDeniedError).digest).toBe(
      'PERMDOCK_DENIED;post.update',
    );

    const approval = thrown(() =>
      member.assert(permissions.post.delete, ownPost),
    );
    expect(approval).toBeInstanceOf(PermDockApprovalRequiredError);
    // SAFETY: checked by toBeInstanceOf above.
    const error = approval as PermDockApprovalRequiredError;
    expect(parsePermDockDigest(error.digest)).toEqual({
      outcome: 'approval-required',
      permission: 'post.delete',
      token: error.token,
    });

    const again = thrown(() => member.assert(permissions.post.delete, ownPost));
    // SAFETY: the same call as above, which threw a PermDockApprovalRequiredError.
    expect((again as PermDockApprovalRequiredError).digest).toBe(error.digest);
    const admin = await createPermDock(policy, adminUser);
    expect(thrown(() => admin.assert(permissions.post.delete, ownPost))).toBe(
      null,
    );
  });
});
