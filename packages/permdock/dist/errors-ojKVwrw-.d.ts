import { d as Subject } from "./subject-BcgWbogX.js";
import { B as Decision } from "./policy-B9ZJilUm.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/core/errors.d.ts
type ProblemDetails = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly permission?: string;
  readonly scope?: string;
  readonly resource?: {
    readonly type: string;
    readonly id?: string;
  };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly reason?: string;
  readonly token?: string;
  readonly issues?: readonly StandardSchemaV1.Issue[];
};
declare class PermDockDeniedError extends Error {
  override readonly name: "PermDockDeniedError";
  readonly decision: Extract<Decision, {
    readonly outcome: "denied";
  }>;
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: Subject;
  constructor(input: {
    readonly decision: Extract<Decision, {
      readonly outcome: "denied";
    }>;
    readonly permission: string;
    readonly scope: string;
    readonly resource: {
      readonly type: string;
      readonly id?: string;
    };
    readonly subject: Subject;
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
declare class PermDockApprovalRequiredError extends Error {
  override readonly name: "PermDockApprovalRequiredError";
  readonly decision: Extract<Decision, {
    readonly outcome: "approval-required";
  }>;
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly token: string;
  readonly reason: string;
  constructor(input: {
    readonly decision: Extract<Decision, {
      readonly outcome: "approval-required";
    }>;
    readonly permission: string;
    readonly scope: string;
    readonly resource: {
      readonly type: string;
      readonly id?: string;
    };
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
declare class PermDockValidationError extends Error {
  override readonly name: "PermDockValidationError";
  readonly code: "invalid-data" | "async-schema" | "no-schema" | "non-portable-condition";
  readonly permission: string;
  readonly resource: string;
  readonly issues: readonly StandardSchemaV1.Issue[];
  readonly boundary: string;
  constructor(input: {
    readonly code: "invalid-data" | "async-schema" | "no-schema" | "non-portable-condition";
    readonly permission: string;
    readonly resource: string;
    readonly issues?: readonly StandardSchemaV1.Issue[];
    readonly boundary: string;
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
//#endregion
export { ProblemDetails as i, PermDockDeniedError as n, PermDockValidationError as r, PermDockApprovalRequiredError as t };