import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';
import type { FormatOptions, TerminalProblemDetails } from './types.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  approvalMessage,
  deniedMessage,
} from '../core/errors.ts';
import { EX_NOPERM, EX_OK, EX_TEMPFAIL } from './exit.ts';

export function exitCode(decision: Decision): number {
  switch (decision.outcome) {
    case 'granted':
      return EX_OK;
    case 'approval-required':
      return EX_TEMPFAIL;
    case 'denied':
      return EX_NOPERM;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function permissionKey(
  decision: Decision,
  permission: Permission | undefined,
): string {
  if (permission !== undefined) {
    return permission.key;
  }
  if (decision.outcome === 'granted') {
    return decision.matched.permission;
  }
  if (decision.outcome === 'approval-required') {
    return decision.grant.permission;
  }
  return 'unknown';
}

function permissionScope(permission: Permission | undefined): string {
  return permission?.scope ?? '';
}

function resourceOf(permission: Permission | undefined): {
  readonly type: string;
  readonly id?: string;
} {
  return { type: permission?.resource ?? 'unknown' };
}

export function formatDecision(
  decision: Decision,
  options: FormatOptions = {},
): string {
  const json = options.json === true;
  const key = permissionKey(decision, options.permission);
  const scope = permissionScope(options.permission);
  const resource = resourceOf(options.permission);
  const subject: Subject | undefined = options.subject;

  if (decision.outcome === 'granted') {
    return json
      ? `${JSON.stringify({ outcome: 'granted', permission: key })}\n`
      : '';
  }

  if (decision.outcome === 'approval-required') {
    const error = new PermDockApprovalRequiredError({
      decision,
      permission: key,
      scope,
      resource,
      message: approvalMessage(key, decision.reason, decision.token),
    });
    const details: TerminalProblemDetails = compact<TerminalProblemDetails>({
      ...error.toProblemDetails(compact({ instance: options.instance })),
      approval: options.approval,
    });
    if (json) {
      return `${JSON.stringify(details)}\n`;
    }
    return `${details.detail}\n`;
  }

  const error = new PermDockDeniedError({
    decision,
    permission: key,
    scope,
    resource,
    subject: subject ?? { principal: null, context: {} },
    message: deniedMessage(
      key,
      subject?.principal?.id,
      decision.denials,
      decision.alternatives.map((leaf) => leaf.key),
    ),
  });
  const details = error.toProblemDetails(
    compact({ instance: options.instance }),
  );
  if (json) {
    return `${JSON.stringify(details)}\n`;
  }
  return `${details.detail}\n`;
}
