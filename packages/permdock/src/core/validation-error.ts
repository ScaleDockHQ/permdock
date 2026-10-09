import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ProblemDetails } from "./errors.ts";

import { compact } from "./compact.ts";

/** The base of every Problem Details `type` URI; defined here so a validation error does not pull in the Problem Details builders. */
export const PROBLEM_BASE = "https://permdock.com/problems";

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
