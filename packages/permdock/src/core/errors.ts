import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Decision } from "./decision.ts";
import type { Subject } from "./subject.ts";
import type { WireDenial } from "./wire-denial.ts";

import { compact } from "./compact.ts";
import { approvalDigest, deniedDigest } from "./digest.ts";
import { wireDenials } from "./wire-denial.ts";

/** Where and how a human approves; carries no secret. */
export type ApprovalHint = {
  readonly at?: string;
  readonly hint?: string;
};

export type ProblemDetails = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly permission?: string;
  readonly scope?: string;
  readonly resource?: { readonly type: string; readonly id?: string };
  readonly denials?: readonly WireDenial[];
  readonly alternatives?: readonly string[];
  readonly reason?: string;
  readonly token?: string;
  readonly issues?: readonly StandardSchemaV1.Issue[];
  readonly approval?: ApprovalHint;
  /** RFC 9470 step-up parameters on `step-up-required`. */
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
  /** The plans that would grant the permission, on `not-entitled`. */
  readonly plans?: readonly string[];
};

const PROBLEM_BASE = "https://permdock.com/problems";

export class PermDockDeniedError extends Error {
  public override readonly name = "PermDockDeniedError" as const;
  public readonly decision: Extract<Decision, { readonly outcome: "denied" }>;
  public readonly permission: string;
  public readonly scope: string;
  public readonly resource: { readonly type: string; readonly id?: string };
  public readonly subject: Subject;
  /** `PERMDOCK_DENIED;<permission>`; survives the Server Component boundary (`parsePermDockDigest`). */
  public readonly digest: string;

  public constructor(input: {
    readonly decision: Extract<Decision, { readonly outcome: "denied" }>;
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
    this.digest = deniedDigest(input.permission);
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/denied`,
      title: "Permission denied",
      status: 403,
      detail: this.message,
      instance: options?.instance,
      permission: this.permission,
      scope: this.scope,
      resource: this.resource,
      denials: wireDenials(this.decision.denials),
      alternatives: this.decision.alternatives.map((leaf) => leaf.key),
    });
  }
}

export class PermDockApprovalRequiredError extends Error {
  public override readonly name = "PermDockApprovalRequiredError" as const;
  public readonly decision: Extract<
    Decision,
    { readonly outcome: "approval-required" }
  >;
  public readonly permission: string;
  public readonly scope: string;
  public readonly resource: { readonly type: string; readonly id?: string };
  public readonly token: string;
  public readonly reason: string;
  /** `PERMDOCK_APPROVAL_REQUIRED;<permission>;<token>`; the token is already bound to this subject. */
  public readonly digest: string;

  public constructor(input: {
    readonly decision: Extract<
      Decision,
      { readonly outcome: "approval-required" }
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
    this.digest = approvalDigest(input.permission, input.decision.token);
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/approval-required`,
      title: "Approval required",
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
  public override readonly name = "PermDockValidationError" as const;
  public readonly code:
    | "invalid-data"
    | "async-schema"
    | "no-schema"
    | "non-portable-condition";
  public readonly permission: string;
  public readonly resource: string;
  public readonly issues: readonly StandardSchemaV1.Issue[];
  public readonly boundary: string;

  public constructor(input: {
    readonly code:
      | "invalid-data"
      | "async-schema"
      | "no-schema"
      | "non-portable-condition";
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
      title: "Invalid resource data",
      status: 400,
      detail: this.message,
      instance: options?.instance,
      permission: this.permission,
      issues: this.issues,
    });
  }
}

/** The `name` of the deny grant a `deny` denial carries in `detail`, if any. */
function denyName(detail: unknown): string | undefined {
  if (detail === null || typeof detail !== "object" || !("name" in detail)) {
    return undefined;
  }
  return typeof detail.name === "string" ? detail.name : undefined;
}

export function deniedMessage(
  permission: string,
  subjectId: string | undefined,
  denials: readonly {
    readonly role: string | null;
    readonly reason: string;
    readonly detail?: unknown;
  }[],
  alternatives: readonly string[],
): string {
  const clauses = denials
    .map((denial) => {
      const name =
        denial.reason === "deny" ? denyName(denial.detail) : undefined;
      return name === undefined
        ? `${denial.role ?? "none"} (${denial.reason})`
        : `${denial.role ?? "none"} (${denial.reason} '${name}')`;
    })
    .join(", ");
  const alt =
    alternatives.length === 0
      ? ""
      : ` Alternatives: ${alternatives.join(", ")}.`;
  return `${permission} denied for subject ${subjectId ?? "anonymous"}: ${clauses}.${alt}`;
}

export function approvalMessage(
  permission: string,
  reason: string,
  token: string,
): string {
  return `${permission} requires human approval (${reason}). Token: ${token}.`;
}

export type RevokedCode =
  | "session-revoked"
  | "expired"
  | "denied"
  | "subject-changed";

/**
 * The `reason` of a long-lived connection's aborted `signal`. `denied` carries
 * the decision that re-denied the permission the connection was opened for.
 */
export class PermDockRevokedError extends Error {
  public override readonly name = "PermDockRevokedError" as const;
  public readonly code: RevokedCode;
  public readonly permission?: string;
  public readonly decision?: Exclude<Decision, { readonly outcome: "granted" }>;

  public constructor(input: {
    readonly code: RevokedCode;
    readonly permission?: string;
    readonly decision?: Exclude<Decision, { readonly outcome: "granted" }>;
  }) {
    super(`PermDock: connection ended (${input.code}).`);
    this.code = input.code;
    if (input.permission !== undefined) {
      this.permission = input.permission;
    }
    if (input.decision !== undefined) {
      this.decision = input.decision;
    }
  }

  public toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails {
    if (this.code === "denied") {
      return compact<ProblemDetails>({
        type: `${PROBLEM_BASE}/denied`,
        title: "Permission denied",
        status: 403,
        detail: this.code,
        instance: options?.instance,
        permission: this.permission,
        denials:
          this.decision?.outcome === "denied"
            ? wireDenials(this.decision.denials)
            : undefined,
      });
    }
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/unauthenticated`,
      title: "Authorization ended",
      status: 401,
      detail: this.code,
      instance: options?.instance,
      permission: this.permission,
    });
  }
}
