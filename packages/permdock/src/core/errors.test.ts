import { describe, expect, it } from 'vitest';

import type { Decision } from './decision.ts';

import { describe as describeDecision } from './describe.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from './errors.ts';

describe('errors and describe', () => {
  it('maps denials to Problem Details', () => {
    const decision: Decision = {
      outcome: 'denied',
      denials: [{ role: 'member', reason: 'condition' }],
      alternatives: [
        {
          key: 'post.read',
          scope: 'post:read',
          resource: 'post',
          action: 'read',
          meta: {},
        },
      ],
    };
    const error = new PermDockDeniedError({
      decision,
      permission: 'post.update',
      scope: 'post:update',
      resource: { type: 'post', id: 'p1' },
      subject: { principal: { id: 'u1' }, context: {} },
      message: 'denied',
    });
    expect(error.toProblemDetails({ instance: '/posts/1' }).instance).toBe(
      '/posts/1',
    );
    expect(error.toProblemDetails().type).toContain('/denied');
    expect(describeDecision(decision).kind).toBe('denied');
  });

  it('describes approval, tenant and delegation denials', () => {
    expect(
      describeDecision({
        outcome: 'approval-required',
        grant: { role: 'member', permission: 'post.delete' },
        reason: 'human',
        token: 'pd1.x',
      }).kind,
    ).toBe('approval');
    expect(
      describeDecision({
        outcome: 'denied',
        denials: [{ role: null, reason: 'tenant-mismatch' }],
        alternatives: [],
      }).kind,
    ).toBe('tenant');
    expect(
      describeDecision({
        outcome: 'denied',
        denials: [{ role: null, reason: 'not-delegated' }],
        alternatives: [],
      }).kind,
    ).toBe('delegation');
    expect(
      describeDecision({
        outcome: 'denied',
        denials: [{ role: null, reason: 'opaque-condition' }],
        alternatives: [],
      }).kind,
    ).toBe('server-only');
    expect(
      describeDecision({
        outcome: 'granted',
        subject: { principal: { id: 'u1' }, context: {} },
        matched: { role: 'member', permission: 'post.read' },
        token: 'pd1.x',
      }).kind,
    ).toBe('granted');
  });

  it('builds approval and validation problem details', () => {
    const approval = new PermDockApprovalRequiredError({
      decision: {
        outcome: 'approval-required',
        grant: { role: 'member', permission: 'post.delete' },
        reason: 'human',
        token: 'pd1.x',
      },
      permission: 'post.delete',
      scope: 'post:delete',
      resource: { type: 'post' },
      message: 'needs approval',
    });
    expect(approval.toProblemDetails().token).toBe('pd1.x');
    const validation = new PermDockValidationError({
      code: 'invalid-data',
      permission: 'post.update',
      resource: 'post',
      boundary: 'http-body',
      message: 'bad',
      issues: [{ message: 'required' }],
    });
    expect(
      approval.toProblemDetails({ instance: '/approvals/1' }).instance,
    ).toBe('/approvals/1');
    expect(validation.toProblemDetails().status).toBe(400);
    const noIssues = new PermDockValidationError({
      code: 'no-schema',
      permission: 'post.update',
      resource: 'post',
      boundary: 'manual',
      message: 'none',
    });
    expect(noIssues.toProblemDetails().status).toBe(400);
    expect(
      deniedMessage(
        'post.read',
        undefined,
        [{ role: null, reason: 'anonymous' }],
        [],
      ),
    ).toContain('anonymous');
    expect(
      deniedMessage(
        'post.read',
        'u1',
        [{ role: 'member', reason: 'condition' }],
        ['post.list'],
      ),
    ).toContain('Alternatives');
    expect(approvalMessage('post.delete', 'human', 'pd1.x')).toContain('pd1.x');
  });
});
