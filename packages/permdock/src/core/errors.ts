import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Decision } from './decision.ts';
import type { Subject } from './subject.ts';

import { compact } from './compact.ts';

export type ProblemDetails = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly permission?: string;
  readonly scope?: string;
  readonly resource?: { readonly type: string; readonly id?: string };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly reason?: string;
  readonly token?: string;
  readonly issues?: readonly StandardSchemaV1.Issue[];
};

const PROBLEM_BASE = 'https://permdock.dev/problems';

export class PermDockDeniedError extends Error {
  public override readonly name = 'PermDockDeniedError' as const;
  public readonly decision: Extract<Decision, { readonly outcome: 'denied' }>;
  public readonly permission: string;
  public readonly scope: string;
  public readonly resource: { readonly type: string; readonly id?: string };
  public readonly subject: Subject;

  public constructor(input: {
    readonly decision: Extract<Decision, { readonly outcome: 'denied' }>;
    readonly permission: string;
    readonly scope: string;
    readonly resource: { readonly type: string; readonly id?: string };
    readonly subject: Subject;
    readonly message: string;
  }) {
    super(input.message);
    this.decision = input.decision;
    this.permission = input.permission;
    this.scope = input.scope;
    this.resource = input.resource;
    this.subject = input.subject;
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/denied`,
      title: 'Permission denied',
      status: 403,
      detail: this.message,
      instance: options?.instance,
      permission: this.permission,
      scope: this.scope,
      resource: this.resource,
      denials: this.decision.denials,
      alternatives: this.decision.alternatives.map((leaf) => leaf.key),
    });
  }
}

export class PermDockApprovalRequiredError extends Error {
  public override readonly name = 'PermDockApprovalRequiredError' as const;
  public readonly decision: Extract<
    Decision,
    { readonly outcome: 'approval-required' }
  >;
  public readonly permission: string;
  public readonly scope: string;
  public readonly resource: { readonly type: string; readonly id?: string };
  public readonly token: string;
  public readonly reason: string;

  public constructor(input: {
    readonly decision: Extract<
      Decision,
      { readonly outcome: 'approval-required' }
    >;
    readonly permission: string;
    readonly scope: string;
    readonly resource: { readonly type: string; readonly id?: string };
    readonly message: string;
  }) {
    super(input.message);
    this.decision = input.decision;
    this.permission = input.permission;
    this.scope = input.scope;
    this.resource = input.resource;
    this.token = input.decision.token;
    this.reason = input.decision.reason;
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/approval-required`,
      title: 'Approval required',
      status: 403,
      detail: this.message,
      instance: options?.instance,
      permission: this.permission,
      scope: this.scope,
      resource: this.resource,
      reason: this.reason,
      token: this.token,
    });
  }
}

export class PermDockValidationError extends Error {
  public override readonly name = 'PermDockValidationError' as const;
  public readonly code: 'invalid-data' | 'async-schema' | 'no-schema';
  public readonly permission: string;
  public readonly resource: string;
  public readonly issues: readonly StandardSchemaV1.Issue[];
  public readonly boundary: string;

  public constructor(input: {
    readonly code: 'invalid-data' | 'async-schema' | 'no-schema';
    readonly permission: string;
    readonly resource: string;
    readonly issues?: readonly StandardSchemaV1.Issue[];
    readonly boundary: string;
    readonly message: string;
  }) {
    super(input.message);
    this.code = input.code;
    this.permission = input.permission;
    this.resource = input.resource;
    this.issues = input.issues ?? [];
    this.boundary = input.boundary;
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/validation`,
      title: 'Invalid resource data',
      status: 400,
      detail: this.message,
      instance: options?.instance,
      permission: this.permission,
      issues: this.issues,
    });
  }
}

export function deniedMessage(
  permission: string,
  subjectId: string | undefined,
  denials: readonly { readonly role: string | null; readonly reason: string }[],
  alternatives: readonly string[],
): string {
  const clauses = denials
    .map((denial) => `${denial.role ?? 'none'} (${denial.reason})`)
    .join(', ');
  const alt =
    alternatives.length === 0
      ? ''
      : ` Alternatives: ${alternatives.join(', ')}.`;
  return `${permission} denied for subject ${subjectId ?? 'anonymous'}: ${clauses}.${alt}`;
}

export function approvalMessage(
  permission: string,
  reason: string,
  token: string,
): string {
  return `${permission} requires human approval (${reason}). Token: ${token}.`;
}
