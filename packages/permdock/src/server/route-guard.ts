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
import { LOAD_FAILED } from "../core/decision.ts";
import { challengeScope } from "../core/oauth-scopes.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { decideSet, permissionList } from "./decide-set.ts";
import { applyApprovalResume } from "./evaluations.ts";
import { hasCredentials } from "./http.ts";
import {
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

/**
 * What `guardOn` reads besides the request: the policy, the kernel options it
 * honours and the adapter name.
 */
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

/** `protectOptions.rows` bound to the request, or `undefined` without it. */
function rowsLoader(
  protectOptions: ProtectOptions,
  load: unknown,
  request: Request | undefined,
): (() => readonly unknown[] | Promise<readonly unknown[]>) | undefined {
  const { rows } = protectOptions;
  if (rows === undefined) {
    return undefined;
  }
  if (load !== undefined) {
    throw new TypeError("PermDock: protect takes data or rows, not both");
  }
  if (request === undefined) {
    throw new TypeError("PermDock: protect rows needs the request");
  }
  return () => rows(request);
}

export async function guardOn<T, V extends PolicyVocabulary>(
  deps: RouteGuardDeps,
  instance: PermDock<V>,
  remote: PdpPermDock | undefined,
  report: Report,
  request: Request | undefined,
  permission: Permission | readonly Permission[] | null,
  load: (() => ReturnType<Loader<T>>) | undefined,
  protectOptions: ProtectOptions,
): Promise<Guard<T, V> | ScopeGuard<T, V>> {
  const permissions = permission === null ? null : permissionList(permission);
  const lead = permissions?.[0] ?? null;
  const loadRows = rowsLoader(protectOptions, load, request);
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
      scopeProblem(lead, instance.subject, credentials, declared[0]),
      NOT_DELEGATED,
      request,
      report,
    );
  }
  let data: T | undefined;
  let rows: readonly unknown[] | undefined;
  const loader = loadRows ?? load;
  if (loader !== undefined) {
    let loaded: unknown;
    try {
      loaded = await loader();
    } catch (error) {
      report(error);
      return refused(
        deps.options.deniedResponse,
        loadFailedProblem(lead),
        LOAD_FAILED,
        request,
        report,
      );
    }
    if (
      loaded === null ||
      loaded === undefined ||
      (loadRows !== undefined &&
        (!Array.isArray(loaded) || loaded.length === 0))
    ) {
      return { ok: false, response: notFoundProblem() };
    }
    if (loadRows === undefined) {
      // SAFETY: loaded is the data loader's non-null result, typed T.
      data = loaded as T;
    } else {
      // SAFETY: Array.isArray checked loaded above; the rows stay unknown.
      rows = loaded as readonly unknown[];
      // SAFETY: with rows, the guard's data is the loaded list.
      data = rows as T;
    }
  }
  if (permissions === null || lead === null) {
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
  const decideOne = async (
    next: Permission,
    row: unknown,
  ): Promise<Decision> => {
    // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
    const raw =
      remote === undefined
        ? (
            instance.decide as (
              next: Permission,
              row?: unknown,
              options?: DecideOptions,
            ) => Decision
          )(next, row, decideOptions)
        : await remote
            .decide(next, row, decideOptions)
            .catch((): Decision => ({
              outcome: "denied",
              denials: [{ role: null, reason: "pdp-unavailable" }],
              alternatives: [],
            }));
    return applyApprovalResume(
      raw,
      next,
      instance,
      deps.options.store,
      request,
      resourceRef(next, row),
      deps.adapter,
    );
  };
  const decideRows = (
    next: Permission,
    batch: readonly unknown[],
  ): Promise<readonly Decision[]> => {
    if (remote !== undefined) {
      return Promise.all(batch.map((row) => decideOne(next, row)));
    }
    // SAFETY: decideEach's generics only tie the row type to the permission; it accepts any row.
    const each = instance.decideEach as (
      next: Permission,
      rows: readonly unknown[],
      options?: DecideOptions,
    ) => readonly Decision[];
    return Promise.all(
      each(next, batch, decideOptions).map((raw, index) =>
        applyApprovalResume(
          raw,
          next,
          instance,
          deps.options.store,
          request,
          resourceRef(next, batch[index]),
          deps.adapter,
        ),
      ),
    );
  };
  let decision: Decision;
  let refusedPermission = lead;
  let refusedRow: unknown = data;
  if (rows === undefined && permissions.length === 1) {
    decision = await decideOne(lead, data);
  } else {
    const set = await decideSet(
      permissions,
      rows ?? [data],
      protectOptions.anyOf === true,
      rows === undefined
        ? (next, batch): Promise<readonly Decision[]> =>
            Promise.all(batch.map((row) => decideOne(next, row)))
        : decideRows,
    );
    decision = set.decision;
    if (!set.ok) {
      refusedPermission = set.permission;
      refusedRow = set.row;
    }
  }
  if (decision.outcome === "granted") {
    // SAFETY: T is the data loader's result type; data is undefined only when no loader was passed.
    return { ok: true, permdock: instance, decision, data: data as T };
  }
  return refused(
    deps.options.deniedResponse,
    problemFromDecision(
      decision,
      refusedPermission,
      instance.subject,
      compact({
        approval: deps.options.approval,
        credentials,
        scope: declared?.[0] ?? challengeScope(deps.policy, refusedPermission),
        disclosure:
          refusedRow === undefined
            ? undefined
            : deps.policy.resources.get(refusedPermission.resource)?.disclosure,
      }),
    ),
    decision,
    request,
    report,
  );
}
