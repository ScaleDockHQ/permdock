import type { Decision } from "../core/decision.ts";
import type { ProblemDetails } from "../core/errors.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Report } from "../core/request-context.ts";
import type { PdpPermDock } from "../pdp/types.ts";
import type {
  Guard,
  Loader,
  ProtectOptions,
  ScopeGuard,
  ServerPermDockOptions,
} from "./server-types.ts";

import { compact } from "../core/compact.ts";
import { challengeScope } from "../core/oauth-scopes.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { applyApprovalResume } from "./evaluations.ts";
import { hasCredentials } from "./http.ts";
import {
  LOAD_FAILED,
  NOT_DELEGATED,
  loadFailedProblem,
  scopeProblem,
} from "./kernel-problems.ts";
import {
  ANONYMOUS,
  notFoundProblem,
  problemFromDecision,
  unauthenticatedProblem,
} from "./problem.ts";

/** What `guardOn` reads besides the request: the policy, the kernel options it honours and the adapter name. */
export type RouteGuardDeps = {
  readonly policy: Policy;
  readonly options: Pick<
    ServerPermDockOptions,
    "operations" | "deniedResponse" | "store" | "approval"
  >;
  readonly adapter: string;
};

export function routeScopes(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scopes: unknown[] = Array.isArray(value) ? value : [];
  const names = scopes.filter(
    (scope): scope is string => typeof scope === "string" && scope !== "",
  );
  if (names.length === 0 || names.length !== scopes.length) {
    throw new TypeError(
      "PermDock: oauthScopes must be a non-empty list of scope names",
    );
  }
  return names;
}

async function refused(
  hook: ServerPermDockOptions["deniedResponse"],
  fallback: Response,
  decision: Exclude<Decision, { readonly outcome: "granted" }>,
  request: Request | undefined,
  report: Report,
): Promise<{
  readonly ok: false;
  readonly response: Response;
  readonly decision: Exclude<Decision, { readonly outcome: "granted" }>;
}> {
  if (hook === undefined) {
    return { ok: false, response: fallback, decision };
  }
  try {
    // SAFETY: every refusal response the kernel builds carries a Problem Details body.
    const problem = (await fallback.clone().json()) as ProblemDetails;
    const result = await hook({ decision, problem, request });
    if (result === undefined) {
      return { ok: false, response: fallback, decision };
    }
    const status = result.status;
    if (typeof status !== "number" || status < 300) {
      throw new TypeError(
        `PermDock: deniedResponse returned status ${String(status)}; a refusal keeps a status of 300 or more`,
      );
    }
    return {
      ok: false,
      response:
        result instanceof Response
          ? result
          : new Response(JSON.stringify(result), {
              status,
              headers: fallback.headers,
            }),
      decision,
    };
  } catch (error) {
    report(error);
    return { ok: false, response: fallback, decision };
  }
}

export async function guardOn<T, V extends PolicyVocabulary>(
  deps: RouteGuardDeps,
  instance: PermDock<V>,
  remote: PdpPermDock | undefined,
  report: Report,
  request: Request | undefined,
  permission: Permission | null,
  load: (() => ReturnType<Loader<T>>) | undefined,
  protectOptions: ProtectOptions,
): Promise<Guard<T, V> | ScopeGuard<T, V>> {
  const declared = routeScopes(
    protectOptions.oauthScopes ??
      (request === undefined
        ? undefined
        : deps.options.operations?.oauthScopesForRequest(
            request.method,
            new URL(request.url).pathname,
          )),
  );
  const credentials = request === undefined ? false : hasCredentials(request);
  if (permission === null) {
    if (declared === undefined) {
      throw new TypeError(
        request === undefined
          ? "PermDock: protect(null) needs oauthScopes"
          : `PermDock: protect(null) needs oauthScopes, and no operation declares them for ${request.method} ${new URL(request.url).pathname}`,
      );
    }
    if (instance.subject.principal === null) {
      return refused(
        deps.options.deniedResponse,
        unauthenticatedProblem(credentials),
        ANONYMOUS,
        request,
        report,
      );
    }
  }
  const { actor, delegation } = instance.subject;
  // A route without a permission has no decision to clip a delegation, so a
  // delegated token without scopes holds none of them.
  const held =
    permission === null && (actor !== undefined || delegation !== undefined)
      ? (delegation?.scopes ?? [])
      : delegation?.scopes;
  if (
    declared !== undefined &&
    held !== undefined &&
    !declared.some((granted) => held.includes(granted))
  ) {
    return refused(
      deps.options.deniedResponse,
      scopeProblem(permission, instance.subject, credentials, declared[0]),
      NOT_DELEGATED,
      request,
      report,
    );
  }
  let data: T | undefined;
  if (load !== undefined) {
    let loaded: T | null | undefined;
    try {
      loaded = await load();
    } catch (error) {
      report(error);
      return refused(
        deps.options.deniedResponse,
        loadFailedProblem(permission),
        LOAD_FAILED,
        request,
        report,
      );
    }
    if (loaded === null || loaded === undefined) {
      return { ok: false, response: notFoundProblem() };
    }
    data = loaded;
  }
  if (permission === null) {
    // SAFETY: T is the data loader's result type; data is undefined only when no loader was passed.
    return { ok: true, permdock: instance, data: data as T };
  }
  const decideOptions = compact<DecideOptions>({
    call: "adapter",
    adapter: deps.adapter,
    field: protectOptions.field,
    explain: protectOptions.explain,
    ...(protectOptions.trusted === true
      ? { trusted: true }
      : { trusted: false, boundary: "http-body" as const }),
  });
  // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
  const raw =
    remote === undefined
      ? (
          instance.decide as (
            next: Permission,
            row?: unknown,
            options?: DecideOptions,
          ) => Decision
        )(permission, data, decideOptions)
      : await remote
          .decide(permission, data, decideOptions)
          .catch((): Decision => ({
            outcome: "denied",
            denials: [{ role: null, reason: "pdp-unavailable" }],
            alternatives: [],
          }));
  const decision = await applyApprovalResume(
    raw,
    permission,
    instance,
    deps.options.store,
    request,
    resourceRef(permission, data),
    deps.adapter,
  );
  if (decision.outcome === "granted") {
    // SAFETY: T is the data loader's result type; data is undefined only when no loader was passed.
    return {
      ok: true,
      permdock: instance,
      decision,
      data: data as T,
    };
  }
  return refused(
    deps.options.deniedResponse,
    problemFromDecision(
      decision,
      permission,
      instance.subject,
      compact({
        approval: deps.options.approval,
        credentials,
        scope: declared?.[0] ?? challengeScope(deps.policy, permission),
        disclosure:
          data === undefined
            ? undefined
            : deps.policy.resources.get(permission.resource)?.disclosure,
      }),
    ),
    decision,
    request,
    report,
  );
}
