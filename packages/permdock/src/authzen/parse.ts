import type { ProblemDetails } from "../core/errors.ts";
import type { EvaluationsSemantic } from "../server/evaluations.ts";
import type { AuthzenItem } from "./map.ts";
import type { AuthzenPageRequest } from "./page.ts";

import { compact, isRecord } from "../core/compact.ts";
import { problemType, statusProblem } from "../core/problem-types.ts";
import { MAX_BODY_BYTES, readBodyText } from "../server/body-text.ts";
import {
  EVALUATIONS_SEMANTICS,
  evaluationsSemantic,
} from "../server/evaluations.ts";
import { DEFAULT_MAX_EVALUATIONS } from "../server/problem.ts";
import { mergeEvaluationItem } from "./map.ts";
import { readAuthzenPage } from "./page.ts";

export type AuthzenRequestKind =
  | "evaluation"
  | "evaluations"
  | "search/subject"
  | "search/resource"
  | "search/action";

export type AuthzenSearchKind = Extract<AuthzenRequestKind, `search/${string}`>;

/**
 * A checked AuthZEN request. An `evaluations` body with no items is the
 * single evaluation AuthZEN 1.0 section 7.1 makes it, so it parses as
 * `kind: "evaluation"`; the `evaluations` items already carry the shared
 * top-level fields.
 */
export type AuthzenRequest =
  | AuthzenEvaluationRequest
  | AuthzenEvaluationsRequest
  | AuthzenSearchRequest;

export type AuthzenEvaluationRequest = {
  readonly kind: "evaluation";
  readonly item: AuthzenItem;
};

export type AuthzenEvaluationsRequest = {
  readonly kind: "evaluations";
  readonly semantic: EvaluationsSemantic;
  readonly items: readonly AuthzenItem[];
};

export type AuthzenSearchRequest<
  K extends AuthzenSearchKind = AuthzenSearchKind,
> = {
  readonly kind: K;
  readonly item: AuthzenItem;
  readonly page: AuthzenPageRequest;
};

/** The requests a body for `kind` can parse into. */
export type AuthzenRequestOf<K extends AuthzenRequestKind> =
  K extends "evaluation"
    ? AuthzenEvaluationRequest
    : K extends "evaluations"
      ? AuthzenEvaluationRequest | AuthzenEvaluationsRequest
      : K extends AuthzenSearchKind
        ? AuthzenSearchRequest<K>
        : never;

export type ParseAuthzenRequestResult<
  R extends AuthzenRequest = AuthzenRequest,
> =
  | { readonly ok: true; readonly request: R }
  | { readonly ok: false; readonly problem: ProblemDetails };

export type ParseAuthzenRequestOptions = {
  /** The largest `evaluations` batch; default 256. A larger one is a 413. */
  readonly maxEvaluations?: number;
};

type Required = {
  readonly subject?: "type" | "type-id";
  readonly action?: true;
  readonly resource?: "type" | "type-id";
};

/** AuthZEN 1.0 sections 5, 6.1 and 10.1.1. */
const REQUIRED: Readonly<Record<AuthzenRequestKind, Required>> = {
  evaluation: { subject: "type-id", action: true, resource: "type-id" },
  evaluations: { subject: "type-id", action: true, resource: "type-id" },
  "search/action": { subject: "type-id", resource: "type-id" },
  "search/resource": { subject: "type-id", action: true, resource: "type" },
  "search/subject": { subject: "type", action: true, resource: "type-id" },
};

type ParseFailure = Extract<ParseAuthzenRequestResult, { readonly ok: false }>;

function invalid(detail: string): ParseFailure {
  return {
    ok: false,
    problem: compact<ProblemDetails>({
      type: problemType("validation"),
      title: "Invalid request",
      status: 400,
      detail,
    }),
  };
}

/** The first missing entity or field, checked subject, resource, then action. */
function missing(
  body: Readonly<Record<string, unknown>>,
  required: Required,
): ParseFailure | undefined {
  for (const name of ["subject", "resource"] as const) {
    const needs = required[name];
    if (needs === undefined) {
      continue;
    }
    const entity = body[name];
    if (!isRecord(entity) || typeof entity["type"] !== "string") {
      return invalid(`${name}.type is required`);
    }
    if (needs === "type-id" && typeof entity["id"] !== "string") {
      return invalid(`${name}.id is required`);
    }
  }
  if (required.action === true) {
    const action = body["action"];
    if (!isRecord(action) || typeof action["name"] !== "string") {
      return invalid("action.name is required");
    }
  }
  return undefined;
}

function evaluations(
  body: Readonly<Record<string, unknown>>,
  maxEvaluations: number,
): ParseAuthzenRequestResult {
  const items = body["evaluations"] ?? [];
  if (!Array.isArray(items)) {
    return invalid("evaluations must be an array");
  }
  if (items.length === 0) {
    return (
      missing(body, REQUIRED.evaluations) ?? {
        ok: true,
        request: { kind: "evaluation", item: body },
      }
    );
  }
  if (items.length > maxEvaluations) {
    return {
      ok: false,
      problem: statusProblem(
        413,
        `evaluations batch exceeds ${String(maxEvaluations)}`,
      ),
    };
  }
  const semantic = evaluationsSemantic(body);
  if (semantic === undefined) {
    return invalid(
      `options.evaluations_semantic must be one of ${EVALUATIONS_SEMANTICS.join(", ")}`,
    );
  }
  const shared = compact<AuthzenItem>({
    subject: isRecord(body["subject"]) ? body["subject"] : undefined,
    action: isRecord(body["action"]) ? body["action"] : undefined,
    resource: isRecord(body["resource"]) ? body["resource"] : undefined,
    context: body["context"],
  });
  return {
    ok: true,
    request: {
      kind: "evaluations",
      semantic,
      items: items.map((item: unknown) => mergeEvaluationItem(shared, item)),
    },
  };
}

/**
 * Checks a parsed AuthZEN body the way `permdock/authzen` answers it: the body
 * is an object, then each required entity and field in a fixed order, then
 * the `evaluations` array, batch size and semantic. A failure is the 400 (or
 * 413) Problem Details the handler sends, with the same `detail`.
 */
export function parseAuthzenRequest<K extends AuthzenRequestKind>(
  kind: K,
  body: unknown,
  options: ParseAuthzenRequestOptions = {},
): ParseAuthzenRequestResult<AuthzenRequestOf<K>> {
  // SAFETY: parseAny answers a request whose kind is `kind`, or "evaluation" for an empty `evaluations` batch.
  return parseAny(kind, body, options) as ParseAuthzenRequestResult<
    AuthzenRequestOf<K>
  >;
}

function parseAny(
  kind: AuthzenRequestKind,
  body: unknown,
  options: ParseAuthzenRequestOptions,
): ParseAuthzenRequestResult {
  if (!isRecord(body)) {
    return invalid(`${kind} body must be an object`);
  }
  switch (kind) {
    case "evaluation":
      return (
        missing(body, REQUIRED.evaluation) ?? {
          ok: true,
          request: { kind, item: body },
        }
      );
    case "evaluations":
      return evaluations(
        body,
        options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS,
      );
    case "search/action":
    case "search/resource":
    case "search/subject":
      return (
        missing(body, REQUIRED[kind]) ?? {
          ok: true,
          request: { kind, item: body, page: readAuthzenPage(body) },
        }
      );
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * Reads `request` as an AuthZEN body: `Content-Type: application/json`, at
 * most 1 MiB (a 413 above it), valid JSON, then `parseAuthzenRequest`.
 */
export async function readAuthzenRequest<K extends AuthzenRequestKind>(
  kind: K,
  request: Request,
  options: ParseAuthzenRequestOptions = {},
): Promise<ParseAuthzenRequestResult<AuthzenRequestOf<K>>> {
  const type = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json") {
    return invalid("AuthZEN requests must use Content-Type: application/json");
  }
  const read = await readBodyText(request);
  if (!read.ok) {
    return read.cause === "too-large"
      ? {
          ok: false,
          problem: statusProblem(
            413,
            `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
          ),
        }
      : invalid("AuthZEN body was not valid JSON");
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return invalid("AuthZEN body was not valid JSON");
  }
  return parseAuthzenRequest(kind, body, options);
}
