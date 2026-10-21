export type CloudAuthErrorCode =
  | "discovery-failed"
  | "state-mismatch"
  | "issuer-mismatch"
  | "authorization-denied"
  | "token-refused"
  | "invalid-token"
  | "insufficient-scope"
  | "forbidden"
  | "rate-limited"
  | "unreachable"
  | "unexpected-response";

export type CloudAuthErrorDetails = {
  /** The HTTP status, when the Cloud answered. */
  readonly status?: number;
  /**
   * The RFC 6749 or RFC 6750 `error` the Cloud sent (`invalid_grant`,
   * `insufficient_scope`).
   */
  readonly error?: string;
  /** The scope an `insufficient_scope` challenge names. */
  readonly scope?: string;
};

/**
 * A failed `cloudOAuth` call. `code` tells a dead token (`invalid-token`) from
 * a missing scope (`insufficient-scope`).
 */
export class CloudAuthError extends Error {
  public override readonly name = "CloudAuthError" as const;
  public readonly code: CloudAuthErrorCode;
  public readonly status: number | undefined;
  public readonly error: string | undefined;
  public readonly scope: string | undefined;

  public constructor(
    code: CloudAuthErrorCode,
    message: string,
    details: CloudAuthErrorDetails = {},
  ) {
    super(message);
    this.code = code;
    this.status = details.status;
    this.error = details.error;
    this.scope = details.scope;
  }
}

const CODES: ReadonlySet<string> = new Set<CloudAuthErrorCode>([
  "discovery-failed",
  "state-mismatch",
  "issuer-mismatch",
  "authorization-denied",
  "token-refused",
  "invalid-token",
  "insufficient-scope",
  "forbidden",
  "rate-limited",
  "unreachable",
  "unexpected-response",
]);

/**
 * Matches by `name` and `code`, so an error from another copy of the module
 * still maps.
 */
export function isCloudAuthError(value: unknown): value is CloudAuthError {
  if (!(value instanceof Error) || value.name !== "CloudAuthError") {
    return false;
  }
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" && CODES.has(code);
}
