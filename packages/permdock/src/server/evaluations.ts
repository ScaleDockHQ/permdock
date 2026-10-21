import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { WireDecision } from "../core/wire-denial.ts";
import type { PermissionLookup } from "./evaluation-items.ts";

import { readApprovalHeader, resumeDecision } from "../approvals/helpers.ts";
import { compact, isRecord } from "../core/compact.ts";
import { NO_GRANT } from "../core/decision.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { wireDenials } from "../core/wire-denial.ts";
import { readBodyText } from "./body-text.ts";
import { bodyTooLarge } from "./body.ts";
import {
  itemResourceData,
  permissionLookup,
  wireResourceId,
} from "./evaluation-items.ts";
import {
  DEFAULT_MAX_EVALUATIONS,
  batchTooLarge,
  validationProblem,
} from "./problem.ts";
import { InvalidSignatureError } from "./web-bot-auth.ts";

type EvaluationItem = {
  readonly resource?: {
    readonly type?: unknown;
    readonly id?: unknown;
    readonly properties?: unknown;
  };
  readonly action?: { readonly name?: unknown };
};

/** AuthZEN 1.0 section 7.1.2.1 `options.evaluations_semantic` values. */
export const EVALUATIONS_SEMANTICS = [
  "execute_all",
  "deny_on_first_deny",
  "permit_on_first_permit",
] as const;

export type EvaluationsSemantic = (typeof EVALUATIONS_SEMANTICS)[number];

/**
 * The batch's `evaluations_semantic`: `execute_all` when absent, `undefined`
 * for an unknown value.
 */
export function evaluationsSemantic(
  body: Readonly<Record<string, unknown>>,
): EvaluationsSemantic | undefined {
  const options = body["options"];
  const value = isRecord(options) ? options["evaluations_semantic"] : undefined;
  if (value === undefined) {
    return "execute_all";
  }
  return EVALUATIONS_SEMANTICS.find((semantic) => semantic === value);
}

function unknownSemanticProblem(): Response {
  return validationProblem(
    `options.evaluations_semantic must be one of ${EVALUATIONS_SEMANTICS.join(", ")}`,
  );
}

/**
 * Evaluates `items` under `semantic`: all at once for `execute_all`, else in
 * order, stopping after the first deny or permit.
 */
export async function evaluateBatch<
  T extends { readonly decision: boolean },
  I = unknown,
>(
  items: readonly I[],
  semantic: EvaluationsSemantic,
  rowOf: (item: I) => Promise<T>,
): Promise<T[]> {
  if (semantic === "execute_all") {
    return Promise.all(items.map((item) => rowOf(item)));
  }
  const stopOn = semantic === "permit_on_first_permit";
  const rows: T[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- short-circuit semantics evaluate in order and stop early
    const row = await rowOf(item);
    rows.push(row);
    if (row.decision === stopOn) {
      break;
    }
  }
  return rows;
}

/** AuthZEN 1.0 section 10.1.1: a response echoes the request's `X-Request-ID`. */
export function withRequestId(request: Request, response: Response): Response {
  const id = request.headers.get("x-request-id");
  if (id === null || id === "") {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** AuthZEN 1.0 section 9.1 PDP metadata for the PDP at `pdp`. */
export function authzenMetadata(
  pdp: string,
  search: {
    readonly action?: boolean;
    readonly resource?: boolean;
    readonly subject?: boolean;
  } = {},
): Readonly<Record<string, string>> {
  return compact<Record<string, string>>({
    policy_decision_point: pdp,
    access_evaluation_endpoint: `${pdp}/access/v1/evaluation`,
    access_evaluations_endpoint: `${pdp}/access/v1/evaluations`,
    search_subject_endpoint:
      search.subject === true ? `${pdp}/access/v1/search/subject` : undefined,
    search_resource_endpoint:
      search.resource === true ? `${pdp}/access/v1/search/resource` : undefined,
    search_action_endpoint:
      search.action === true ? `${pdp}/access/v1/search/action` : undefined,
  });
}

/** AuthZEN 1.0 section 7.2.1 reasons, keyed by language tag. */
export type EvaluationReasons = {
  readonly reason_admin?: { readonly en: string };
  readonly reason_user?: { readonly en: string };
};

/**
 * `reason_admin` and `reason_user` for a decision that is not granted, from the
 * denial roles and reasons the context already carries. The user reason names
 * no role, grant or subject.
 */
export function evaluationReasons(
  decision: Decision,
  permission: string,
): EvaluationReasons {
  switch (decision.outcome) {
    case "granted": {
      return {};
    }
    case "denied": {
      return {
        reason_admin: {
          en: `${permission} denied: ${decision.denials
            .map((denial) => `${denial.role ?? "none"} (${denial.reason})`)
            .join(", ")}.`,
        },
        reason_user: { en: `${permission} is not permitted.` },
      };
    }
    case "approval-required": {
      return {
        reason_admin: {
          en: `${permission} requires human approval (${decision.reason}).`,
        },
        reason_user: { en: `${permission} requires approval.` },
      };
    }
    default: {
      const exhausted: never = decision;
      return exhausted;
    }
  }
}

function permissionOf(
  lookup: PermissionLookup,
  item: EvaluationItem,
): Permission | undefined {
  return lookup(
    typeof item.action?.name === "string" ? item.action.name : undefined,
    item.resource,
  );
}

function evaluationRow(
  decision: Decision,
  permission: string,
): {
  readonly decision: boolean;
  readonly context: EvaluationReasons & {
    readonly outcome: Decision["outcome"];
    readonly permdock: WireDecision;
  };
} {
  switch (decision.outcome) {
    case "granted":
      return {
        decision: true,
        context: { outcome: "granted", permdock: decision },
      };
    case "denied":
      return {
        decision: false,
        context: {
          outcome: "denied",
          permdock: { ...decision, denials: wireDenials(decision.denials) },
          ...evaluationReasons(decision, permission),
        },
      };
    case "approval-required":
      return {
        decision: false,
        context: {
          outcome: "approval-required",
          permdock: decision,
          ...evaluationReasons(decision, permission),
        },
      };
    default: {
      const exhausted: never = decision;
      return exhausted;
    }
  }
}

export function applyApprovalResume(
  decision: Decision,
  permission: Permission,
  permdock: PermDock,
  store: ApprovalStore | undefined,
  request: Request | undefined,
  resource: { readonly type: string; readonly id?: string },
  adapter: string,
): Promise<Decision> {
  return resumeDecision({
    decision,
    permission,
    subject: permdock.subject,
    store,
    resource,
    adapter,
    token:
      request === undefined ? undefined : readApprovalHeader(request.headers),
  });
}

function evaluateOne(
  lookup: PermissionLookup,
  permdock: PermDock,
  item: EvaluationItem,
  store: ApprovalStore | undefined,
  header: string | undefined,
  adapter: string,
): Promise<{ readonly decision: Decision; readonly permission: string }> {
  const permission = permissionOf(lookup, item);
  if (permission === undefined) {
    return Promise.resolve({
      decision: NO_GRANT,
      permission:
        typeof item.action?.name === "string" ? item.action.name : "unknown",
    });
  }
  const data = itemResourceData(item.resource);
  // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
  const decide = permdock.decide as (
    next: Permission,
    row?: unknown,
    options?: DecideOptions,
  ) => Decision;
  const decision = decide(
    permission,
    data,
    compact<DecideOptions>({
      call: "endpoint",
      adapter,
      trusted: false,
      boundary: "decision-endpoint",
    }),
  );
  return resumeDecision({
    decision,
    permission,
    subject: permdock.subject,
    store,
    resource: resourceRef(permission, data, wireResourceId(item.resource?.id)),
    adapter,
    token: header,
    consume: false,
  }).then((resumed) => ({ decision: resumed, permission: permission.key }));
}

async function resolvePermdock(
  options: {
    readonly resolve?: (request: Request) => Promise<PermDock>;
    readonly getPermDock?: (query?: {
      readonly tenant?: string;
    }) => Promise<PermDock>;
  },
  request: Request,
  tenant?: string,
): Promise<PermDock> {
  if (options.resolve !== undefined) {
    const permdock = await options.resolve(request);
    return tenant === undefined ? permdock : permdock.tenant(tenant);
  }
  if (options.getPermDock !== undefined) {
    return options.getPermDock(tenant === undefined ? undefined : { tenant });
  }
  throw new TypeError("evaluations handler needs resolve or getPermDock");
}

export function evaluationsHandler(options: {
  readonly policy: Policy;
  readonly resolve?: (request: Request) => Promise<PermDock>;
  readonly getPermDock?: (query?: {
    readonly tenant?: string;
  }) => Promise<PermDock>;
  readonly store?: ApprovalStore;
  readonly adapter?: string;
  /**
   * The most evaluations one POST may carry; a larger batch is a 413 before any
   * instance is resolved.
   */
  readonly maxEvaluations?: number;
}): {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
} {
  const adapter = options.adapter ?? "server";
  const lookup = permissionLookup(options.policy.permissions);
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const POST = async (request: Request): Promise<Response> => {
    const read = await readBodyText(request);
    if (!read.ok) {
      return read.cause === "too-large"
        ? bodyTooLarge()
        : validationProblem("evaluations body was not valid JSON");
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text);
    } catch {
      return validationProblem("evaluations body was not valid JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return validationProblem("evaluations body must be an object");
    }
    // SAFETY: body was checked to be a non-array object above; evaluations stays unknown.
    const evaluations = (body as { readonly evaluations?: unknown })
      .evaluations;
    if (evaluations === undefined) {
      return validationProblem("evaluations array is required");
    }
    if (!Array.isArray(evaluations)) {
      return validationProblem("evaluations must be an array");
    }
    if (evaluations.length > maxEvaluations) {
      return batchTooLarge(maxEvaluations);
    }
    // SAFETY: body was checked to be a non-array object above.
    const semantic = evaluationsSemantic(body as Record<string, unknown>);
    if (semantic === undefined) {
      return unknownSemanticProblem();
    }

    const header = readApprovalHeader(request.headers);
    let permdock: PermDock;
    try {
      permdock = await resolvePermdock(options, request);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        return error.response;
      }
      throw error;
    }
    const rows = await evaluateBatch(evaluations, semantic, async (item) => {
      // SAFETY: every EvaluationItem field is optional and read through ?. and typeof checks.
      const entry =
        item !== null && typeof item === "object"
          ? (item as EvaluationItem)
          : {};
      const evaluated = await evaluateOne(
        lookup,
        permdock,
        entry,
        options.store,
        header,
        adapter,
      );
      return evaluationRow(evaluated.decision, evaluated.permission);
    });
    return Response.json({ evaluations: rows });
  };

  const GET = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.includes("authzen-configuration")) {
      return Response.json(authzenMetadata(url.origin));
    }
    const tenant = url.searchParams.get("tenant") ?? undefined;
    let permdock: PermDock;
    try {
      permdock = await resolvePermdock(options, request, tenant);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        return error.response;
      }
      throw error;
    }
    const snapshot = permdock.snapshot();
    return Response.json(await Promise.resolve(snapshot));
  };

  return {
    POST: async (request) => withRequestId(request, await POST(request)),
    GET: async (request) => withRequestId(request, await GET(request)),
  };
}
