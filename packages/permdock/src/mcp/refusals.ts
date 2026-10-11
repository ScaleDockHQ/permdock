import type { CheckFailure } from "../agent/types.ts";
import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { McpPermDockOptions } from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { describe } from "../core/describe.ts";
import { resourceRef } from "../core/resource-ref.ts";
import {
  approvalToolRefusal,
  deniedToolRefusal,
  toolErrorResult,
} from "../core/tool-refusal.ts";
import {
  type BearerChallenge,
  bearerChallenge,
  stepUpOf,
} from "../server/problem.ts";
import { CLIENT_CAPABILITIES, type Context } from "./mcp-auth.ts";

export type Refusal = {
  readonly text: string;
  /** The decision behind the refusal, for `onDenied`. */
  readonly decision?: Exclude<Decision, { readonly outcome: "granted" }>;
  /** The instance that decided, for reporting a failing `onDenied`. */
  readonly permdock?: PermDock;
  readonly structured: Readonly<Record<string, unknown>>;
  /** An MRTR `input_required` result, returned instead of the refusal. */
  readonly inputRequired?: Readonly<Record<string, unknown>>;
};

export type Checked =
  | { readonly ok: true; readonly approved?: string }
  | { readonly ok: false; readonly refusal: Refusal };

/** What a completion re-check still accepts after the handler ran. */
export function stillAllowed(
  decision: Decision,
  approved: string | undefined,
): boolean {
  switch (decision.outcome) {
    case "granted":
      return true;
    case "approval-required":
      return approved !== undefined && decision.token === approved;
    case "denied":
      return (
        decision.denials.length > 0 &&
        decision.denials.every((denial) => denial.reason === "limit")
      );
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export function acceptsUrlElicitation(
  context: Context,
  fallback: (() => unknown) | undefined,
): boolean {
  const fromEnvelope = context.mcpReq?.envelope?.[CLIENT_CAPABILITIES];
  const capabilities = isRecord(fromEnvelope) ? fromEnvelope : fallback?.();
  if (!isRecord(capabilities) || !isRecord(capabilities["elicitation"])) {
    return false;
  }
  return isRecord(capabilities["elicitation"]["url"]);
}

export function withParams(
  at: string,
  params: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(at);
  } catch {
    return undefined;
  }
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}

export function urlElicitation(
  key: string,
  message: string,
  url: string,
  requestState: string | undefined,
): Readonly<Record<string, unknown>> {
  return compact({
    resultType: "input_required",
    inputRequests: {
      [key]: {
        method: "elicitation/create",
        params: { mode: "url", message, url },
      },
    },
    requestState,
  });
}

export function deniedRefusal(
  decision: Extract<Decision, { readonly outcome: "denied" }>,
  permission: Permission,
  data: unknown,
): Refusal {
  return deniedToolRefusal(decision, permission, resourceRef(permission, data));
}

export function approvalRefusal(
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  permission: Permission,
  data: unknown,
): Refusal {
  return approvalToolRefusal(
    decision,
    permission,
    resourceRef(permission, data),
  );
}

export function plainRefusal(
  permission: Permission,
  text: string,
  extra: Readonly<Record<string, unknown>>,
): Refusal {
  return {
    text,
    structured: {
      outcome: "denied",
      permission: permission.key,
      resource: { type: permission.resource },
      alternatives: [],
      ...extra,
    },
  };
}

export function failedRefusal(
  permission: Permission,
  failure: CheckFailure,
): Refusal {
  switch (failure) {
    case "load-failed":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} failed closed.`,
        {
          denials: [{ role: null, reason: "validation" }],
        },
      );
    case "no-data":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} found nothing to decide on.`,
        { denials: [{ role: null, reason: "validation" }] },
      );
    case "failed":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} failed closed.`,
        {},
      );
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

export function toolRefusal(refusal: Refusal): unknown {
  return refusal.inputRequired ?? toolErrorResult(refusal);
}

export function throwRefusal(refusal: Refusal): unknown {
  if (refusal.inputRequired !== undefined) {
    return refusal.inputRequired;
  }
  throw new Error(refusal.text);
}

/** The MRTR URL elicitation that sends the user to `options.approval.at`, when the client accepts one. */
export async function approvalInput(
  options: Pick<McpPermDockOptions, "approval" | "requestState">,
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  handlerContext: unknown,
  context: Context,
  capabilities: (() => unknown) | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const at = options.approval?.at;
  if (at === undefined || !acceptsUrlElicitation(context, capabilities)) {
    return undefined;
  }
  const url = withParams(at, { token: decision.token });
  if (url === undefined) {
    return undefined;
  }
  // SAFETY: handlerContext is the SDK handler context, passed unchanged to the SDK's own codec.
  const requestState =
    options.requestState === undefined
      ? decision.token
      : await options.requestState.mint(
          decision.token,
          handlerContext as never,
        );
  return urlElicitation(
    "approval",
    options.approval?.hint ?? describe(decision).detail,
    url,
    requestState,
  );
}

/** A step-up denial: the RFC 9470 challenge, and a URL elicitation to `stepUpAt` when the client accepts one. */
export function stepUpRefusal(
  stepUpAt: string | undefined,
  decision: Extract<Decision, { readonly outcome: "denied" }>,
  permission: Permission,
  data: unknown,
  context: Context,
  capabilities: (() => unknown) | undefined,
): Refusal {
  const base = deniedRefusal(decision, permission, data);
  const { acrValues, maxAge } = stepUpOf(decision);
  const url =
    stepUpAt === undefined || !acceptsUrlElicitation(context, capabilities)
      ? undefined
      : withParams(stepUpAt, {
          acr_values: acrValues?.join(" "),
          max_age: maxAge === undefined ? undefined : String(maxAge),
        });
  return compact<Refusal>({
    text: base.text,
    structured: compact({
      ...base.structured,
      error: "insufficient_user_authentication",
      acr_values: acrValues?.join(" "),
      max_age: maxAge,
      www_authenticate: bearerChallenge(
        compact<BearerChallenge>({
          error: "insufficient_user_authentication",
          acrValues,
          maxAge,
        }),
      ),
    }),
    inputRequired:
      url === undefined
        ? undefined
        : urlElicitation(
            "step_up",
            `Sign in again to use ${permission.key}.`,
            url,
            undefined,
          ),
  });
}
