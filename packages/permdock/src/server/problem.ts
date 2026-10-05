import type { Decision, LimitDetail } from "../core/decision.ts";
import type { ApprovalHint, ProblemDetails } from "../core/errors.ts";
import type { Grantee } from "../core/grantee.ts";
import type { Permission } from "../core/permissions.ts";
import type { Subject } from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import { requiredPlans } from "../core/describe.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from "../core/errors.ts";

export const PROBLEM_BASE = "https://permdock.com/problems";

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

/** The `acr` values and the tightest `maxAge` the failing assurance grants ask for. */
export function stepUpOf(decision: Decision): {
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
} {
  if (decision.outcome !== "denied") {
    return {};
  }
  const acr = new Set<string>();
  let maxAge: number | undefined;
  for (const denial of decision.denials) {
    if (denial.reason !== "insufficient-user-authentication") {
      continue;
    }
    const grantees =
      denial.to === undefined
        ? []
        : Array.isArray(denial.to)
          ? denial.to
          : [denial.to];
    // SAFETY: to is Grantee | readonly Grantee[]; Array.isArray does not narrow readonly arrays.
    for (const grantee of grantees as readonly Grantee[]) {
      if (grantee.kind !== "assurance") {
        continue;
      }
      for (const value of grantee.acr ?? []) {
        acr.add(value);
      }
      if (grantee.maxAge !== undefined) {
        maxAge =
          maxAge === undefined
            ? grantee.maxAge
            : Math.min(maxAge, grantee.maxAge);
      }
    }
  }
  return compact({
    acrValues: acr.size === 0 ? undefined : [...acr],
    maxAge,
  });
}

/** The `error_description` of every `invalid_token` challenge (RFC 6750 section 3.1). */
const INVALID_TOKEN = "The access token is invalid";

export function wwwAuthenticate(
  decision: Decision,
  permission: Permission | undefined,
  /** Whether the request carried credentials; without any, the challenge has no error code. */
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
        scopes: permission === undefined ? undefined : [permission.scope],
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

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  const id =
    data !== null && typeof data === "object" && "id" in data
      ? data.id
      : undefined;
  return compact({
    type: permission.resource,
    id:
      typeof id === "string" || typeof id === "number" ? String(id) : undefined,
  });
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

/** Reasons that only arise once a matching grant was found, so they reveal nothing hidden. */
const HOLDS_GRANT = new Set<string>([
  "insufficient-user-authentication",
  "limit",
  "limit-unavailable",
]);

export function problemFromDecision(
  decision: Decision,
  permission: Permission,
  subject: Subject,
  options: {
    readonly instance?: string;
    readonly approval?: ApprovalHint;
    /** `'hide'` on a loaded row: a denial answers as `404` `/not-found`. */
    readonly disclosure?: "hide" | "reveal";
    /** Whether the request carried credentials, which picks the `401` challenge. */
    readonly credentials?: boolean;
    /** The scope an `insufficient_scope` challenge names; the permission's own scope when absent. */
    readonly scope?: string;
  } = {},
): Response {
  const challenged =
    options.scope === undefined
      ? permission
      : { ...permission, scope: options.scope };
  const base = PROBLEM_BASE;
  if (decision.outcome === "granted") {
    return new Response(null, { status: 204 });
  }
  if (decision.outcome === "approval-required") {
    const error = new PermDockApprovalRequiredError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef(permission, undefined),
      message: approvalMessage(permission.key, decision.reason, decision.token),
    });
    const details = error.toProblemDetails(
      compact({ instance: options.instance }),
    );
    const approval =
      options.approval === undefined ||
      (options.approval.at === undefined && options.approval.hint === undefined)
        ? undefined
        : compact<ApprovalHint>({
            at: options.approval.at,
            hint: options.approval.hint,
          });
    return problemResponse(
      compact<ProblemDetails>({
        ...details,
        type: `${base}/approval-required`,
        approval,
      }),
      challenged,
      decision,
    );
  }
  const reasons = new Set(decision.denials.map((denial) => denial.reason));
  if (
    options.disclosure === "hide" &&
    ![...reasons].every((reason) => HOLDS_GRANT.has(reason))
  ) {
    return notFoundProblem(options.instance);
  }
  if (
    decision.denials.some(
      (denial) => denial.detail instanceof PermDockValidationError,
    )
  ) {
    const validation = decision.denials[0]?.detail;
    if (validation instanceof PermDockValidationError) {
      return problemResponse(
        validation.toProblemDetails(),
        challenged,
        decision,
      );
    }
  }
  const error = new PermDockDeniedError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, undefined),
    subject,
    message: deniedMessage(
      permission.key,
      subject.principal?.id,
      decision.denials,
      decision.alternatives.map((leaf) => leaf.key),
    ),
  });
  const details = error.toProblemDetails(
    compact({ instance: options.instance }),
  );
  if (reasons.has("anonymous")) {
    return problemResponse(
      compact<ProblemDetails>({
        type: `${base}/unauthenticated`,
        title: "Authentication required",
        status: 401,
        detail: "Authenticate and repeat the request",
        instance: options.instance,
        permission: permission.key,
      }),
      challenged,
      decision,
      undefined,
      options.credentials,
    );
  }
  if (reasons.has("insufficient-user-authentication")) {
    return problemResponse(
      compact<ProblemDetails>({
        ...details,
        status: 401,
        type: `${base}/step-up-required`,
        ...stepUpOf(decision),
      }),
      challenged,
      decision,
    );
  }
  const plans = requiredPlans(decision);
  if (plans.length > 0) {
    return problemResponse(
      {
        ...details,
        type: `${base}/not-entitled`,
        title: "Plan upgrade required",
        plans,
      },
      challenged,
      decision,
    );
  }
  if (reasons.size > 0 && [...reasons].every((reason) => reason === "limit")) {
    return problemResponse(
      {
        ...details,
        status: 429,
        type: `${base}/rate-limited`,
        title: "Rate limit exceeded",
      },
      challenged,
      decision,
      rateLimitHeaders(decision),
    );
  }
  if (
    reasons.has("limit-unavailable") &&
    [...reasons].every(
      (reason) => reason === "limit" || reason === "limit-unavailable",
    )
  ) {
    return problemResponse(
      {
        ...details,
        status: 503,
        type: `${base}/limit-unavailable`,
        title: "Rate limit unavailable",
      },
      challenged,
      decision,
    );
  }
  return problemResponse(
    { ...details, type: `${base}/denied` },
    challenged,
    decision,
  );
}

/** The `404` a missing row and a hidden one share, so the two read the same. */
export function notFoundProblem(instance?: string): Response {
  return problemResponse(
    compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/not-found`,
      title: "Not found",
      status: 404,
      detail: "No such resource",
      instance,
    }),
  );
}
