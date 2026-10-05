import type { Decision, LimitDetail } from "../core/decision.ts";
import type { ApprovalHint, ProblemDetails } from "../core/errors.ts";
import type { Permission } from "../core/permissions.ts";
import type { Disclosure } from "../core/problem-details.ts";
import type { Subject } from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import {
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from "../core/errors.ts";
import {
  PROBLEM_BASE,
  notFoundDetails,
  problemDetails,
  stepUpOf,
} from "../core/problem-details.ts";

export { PROBLEM_BASE, stepUpOf };

function quoted(value: string): string {
  return `"${value.replaceAll(/["\\]/gu, "")}"`;
}

// oxlint-disable-next-line eslint/no-inline-comments -- bundlers only read the annotation inline
const UTF8 = /* @__PURE__ */ new TextEncoder();

/**
 * An RFC 9651 sf-string: `"` and `\` escaped, and anything outside printable
 * ASCII percent-encoded, which the grammar does not allow.
 */
function sfString(value: string): string {
  const escaped = value
    .replaceAll(/[\\"]/gu, (char) => `\\${char}`)
    .replaceAll(/[^\u0020-\u007E]/gu, (char) =>
      Array.from(
        UTF8.encode(char),
        (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      ).join(""),
    );
  return `"${escaped}"`;
}

export type BearerChallenge = {
  readonly error:
    | "invalid_token"
    | "insufficient_scope"
    | "insufficient_user_authentication";
  /** Every scope the operation needs, not the held set plus the missing one. */
  readonly scopes?: readonly string[];
  /** The RFC 9728 Protected Resource Metadata URL. */
  readonly resourceMetadata?: string;
  /** RFC 9470 step-up parameters. */
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
  /** A generic `error_description`; never the verification failure itself. */
  readonly description?: string;
};

/** An RFC 6750 `WWW-Authenticate: Bearer` value. */
export function bearerChallenge(challenge: BearerChallenge): string {
  const parts = [`error=${quoted(challenge.error)}`];
  if (challenge.description !== undefined) {
    parts.push(`error_description=${quoted(challenge.description)}`);
  }
  if (challenge.scopes !== undefined && challenge.scopes.length > 0) {
    parts.push(`scope=${quoted([...new Set(challenge.scopes)].join(" "))}`);
  }
  if (challenge.acrValues !== undefined && challenge.acrValues.length > 0) {
    parts.push(`acr_values=${quoted(challenge.acrValues.join(" "))}`);
  }
  if (challenge.maxAge !== undefined) {
    parts.push(`max_age=${quoted(String(challenge.maxAge))}`);
  }
  if (challenge.resourceMetadata !== undefined) {
    parts.push(`resource_metadata=${quoted(challenge.resourceMetadata)}`);
  }
  return `Bearer ${parts.join(", ")}`;
}

/** The RFC 9728 well-known metadata URL for a resource identifier. */
export function protectedResourceMetadataUrl(resource: URL): string {
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The `error_description` of every `invalid_token` challenge (RFC 6750 section 3.1). */
const INVALID_TOKEN = "The access token is invalid";

export function wwwAuthenticate(
  decision: Decision,
  permission: Permission | undefined,
  /** Whether the request carried credentials; without any, the challenge has no error code. */
  credentials = true,
): string | undefined {
  return challengeFor(decision, permission?.scope, credentials);
}

function challengeFor(
  decision: Decision,
  scope: string | undefined,
  credentials = true,
): string | undefined {
  if (decision.outcome !== "denied") {
    return undefined;
  }
  const reasons = new Set(decision.denials.map((denial) => denial.reason));
  if (reasons.has("insufficient-user-authentication")) {
    return bearerChallenge({
      error: "insufficient_user_authentication",
      ...stepUpOf(decision),
    });
  }
  if (reasons.has("anonymous")) {
    return credentials
      ? bearerChallenge({ error: "invalid_token", description: INVALID_TOKEN })
      : "Bearer";
  }
  if (reasons.has("not-delegated") || reasons.has("no-delegation")) {
    return bearerChallenge(
      compact<BearerChallenge>({
        error: "insufficient_scope",
        scopes: scope === undefined ? undefined : [scope],
      }),
    );
  }
  return undefined;
}

export function problemResponse(
  details: ProblemDetails,
  permission?: Permission,
  decision?: Decision,
  extra?: Readonly<Record<string, string>>,
  credentials?: boolean,
): Response {
  const headers = new Headers({
    ...extra,
    "content-type": "application/problem+json",
  });
  if (decision !== undefined) {
    const challenge = wwwAuthenticate(decision, permission, credentials);
    if (challenge !== undefined) {
      headers.set("WWW-Authenticate", challenge);
    }
  }
  return new Response(JSON.stringify(details), {
    status: details.status,
    headers,
  });
}

/** The most evaluations one batch request may carry, for AuthZEN and the decision endpoint alike. */
export const DEFAULT_MAX_EVALUATIONS = 256;

/** RFC 9457 413 for a batch over `max` evaluations. */
export function batchTooLarge(max: number): Response {
  return problemResponse({
    type: `${PROBLEM_BASE}/payload-too-large`,
    title: "Payload too large",
    status: 413,
    detail: `evaluations batch exceeds ${String(max)}`,
  });
}

export function validationProblem(detail: string): Response {
  return problemResponse(
    compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/validation`,
      title: "Invalid request",
      status: 400,
      detail,
    }),
  );
}

function resourceRef(permission: Permission): { readonly type: string } {
  return { type: permission.resource };
}

function isLimitDetail(value: unknown): value is LimitDetail {
  if (value === null || typeof value !== "object") {
    return false;
  }
  // SAFETY: value is a non-null object; each destructured field is checked below.
  const { count, window, resetsAt } = value as Partial<LimitDetail>;
  return (
    Number.isFinite(count) &&
    Number.isFinite(window) &&
    Number.isFinite(resetsAt)
  );
}

/**
 * `Retry-After` plus the `RateLimit` / `RateLimit-Policy` fields of
 * draft-ietf-httpapi-ratelimit-headers-11, one policy per exhausted grant.
 */
export function rateLimitHeaders(
  decision: Decision,
  now: number = Date.now() / 1000,
): Record<string, string> {
  if (decision.outcome !== "denied") {
    return {};
  }
  const policies = new Map<string, LimitDetail>();
  for (const denial of decision.denials) {
    if (denial.reason !== "limit" || !isLimitDetail(denial.detail)) {
      continue;
    }
    const name = denial.role ?? "default";
    if (!policies.has(name)) {
      policies.set(name, denial.detail);
    }
  }
  if (policies.size === 0) {
    return {};
  }
  const entries = [...policies].map(([name, detail]) => ({
    name: sfString(name),
    detail,
    wait: Math.max(1, Math.ceil(detail.resetsAt - now)),
  }));
  return {
    "Retry-After": String(Math.min(...entries.map((entry) => entry.wait))),
    RateLimit: entries
      .map((entry) => `${entry.name};r=0;t=${entry.wait}`)
      .join(", "),
    "RateLimit-Policy": entries
      .map(
        (entry) =>
          `${entry.name};q=${entry.detail.count};w=${entry.detail.window}`,
      )
      .join(", "),
  };
}

/**
 * The response for a decision's Problem Details: `WWW-Authenticate` for a
 * `401` or a missing delegation, and the rate-limit fields for a `429`. A
 * hidden row's `404` carries neither, so it reads like a missing one.
 */
export function decisionResponse(
  details: ProblemDetails,
  decision: Decision,
  options: {
    readonly scope?: string;
    /** Whether the request carried credentials, which picks the `401` challenge. */
    readonly credentials?: boolean;
  } = {},
): Response {
  const headers = new Headers({
    ...(details.status === 429 ? rateLimitHeaders(decision) : {}),
    "content-type": "application/problem+json",
  });
  const challenge =
    details.status === 404
      ? undefined
      : challengeFor(decision, options.scope, options.credentials);
  if (challenge !== undefined) {
    headers.set("WWW-Authenticate", challenge);
  }
  return new Response(JSON.stringify(details), {
    status: details.status,
    headers,
  });
}

export function problemFromDecision(
  decision: Decision,
  permission: Permission,
  /** Words the `detail`; without one the detail names no subject. */
  subject: Subject | undefined,
  options: {
    readonly instance?: string;
    readonly approval?: ApprovalHint;
    /** `'hide'` on a loaded row: a denial answers as `404` `/not-found`. */
    readonly disclosure?: Disclosure;
    /** Whether the request carried credentials, which picks the `401` challenge. */
    readonly credentials?: boolean;
    /** The scope an `insufficient_scope` challenge names; the permission's own scope when absent. */
    readonly scope?: string;
  } = {},
): Response {
  if (decision.outcome === "granted") {
    return new Response(null, { status: 204 });
  }
  const validation =
    decision.outcome === "denied" ? decision.denials[0]?.detail : undefined;
  if (
    options.disclosure !== "hide" &&
    validation instanceof PermDockValidationError
  ) {
    return problemResponse(
      validation.toProblemDetails(),
      options.scope === undefined
        ? permission
        : { ...permission, scope: options.scope },
      decision,
    );
  }
  const details = problemDetails(
    compact({
      decision,
      detail:
        decision.outcome === "approval-required"
          ? approvalMessage(permission.key, decision.reason, decision.token)
          : deniedMessage(
              permission.key,
              subject?.principal?.id,
              decision.denials,
              decision.alternatives.map((leaf) => leaf.key),
              subject !== undefined,
            ),
      instance: options.instance,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef(permission),
      disclosure: options.disclosure,
    }),
  );
  const approval =
    decision.outcome !== "approval-required" ||
    options.approval === undefined ||
    (options.approval.at === undefined && options.approval.hint === undefined)
      ? undefined
      : compact<ApprovalHint>({
          at: options.approval.at,
          hint: options.approval.hint,
        });
  return decisionResponse(
    approval === undefined ? details : { ...details, approval },
    decision,
    compact({
      scope: options.scope ?? permission.scope,
      credentials: options.credentials,
    }),
  );
}

/** The `404` a missing row and a hidden one share, so the two read the same. */
export function notFoundProblem(instance?: string): Response {
  return problemResponse(notFoundDetails(instance));
}

const ANONYMOUS: Extract<Decision, { readonly outcome: "denied" }> = {
  outcome: "denied",
  denials: [{ role: null, reason: "anonymous" }],
  alternatives: [],
};

/** The `401` for a request with no subject, with the RFC 6750 challenge its credentials call for. */
export function unauthenticatedProblem(credentials: boolean): Response {
  return decisionResponse(
    problemDetails({ decision: ANONYMOUS, detail: "anonymous" }),
    ANONYMOUS,
    { credentials },
  );
}

export function methodNotAllowed(allow: string): Response {
  const response = problemResponse({
    type: `${PROBLEM_BASE}/method-not-allowed`,
    title: "Method not allowed",
    status: 405,
    detail: `use ${allow}`,
  });
  response.headers.set("Allow", allow);
  return response;
}
