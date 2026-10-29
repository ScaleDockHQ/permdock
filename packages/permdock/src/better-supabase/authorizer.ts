import type {
  AuthorizationOutcome,
  AuthorizationRequest,
  AuthorizationResource,
  Authorizer,
  AuthorizerRuntime,
} from "better-supabase/contract";

import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { InstanceCache } from "../core/instance-cache.ts";
import type { Intent, MembershipSource } from "../core/interfaces.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { BetterSupabaseOnError } from "./report.ts";
import type { BetterSupabaseSubjectOptions } from "./subject.ts";

import { resumeDecision } from "../approvals/helpers.ts";
import { parseApprovalHeader } from "../core/approval-header.ts";
import { canonicalJson } from "../core/canonical-json.ts";
import { isRecord } from "../core/compact.ts";
import { isPermission } from "../core/permission-registry.ts";
import { permdockResolver } from "./permdock-for.ts";
import { deniedMessage, report } from "./report.ts";

/**
 * The table operations better-supabase's `permissions: true` resolves through
 * `forOperation`.
 */
export type AuthorizerOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete";

export type AuthorizerOptions = {
  readonly policy: Policy;
  /**
   * How the verified claims map to a subject; the defaults of
   * `subjectFromBetterSupabase`.
   */
  readonly subject?: Omit<BetterSupabaseSubjectOptions, "apiKeys">;
  /**
   * The permission of each table operation, so a resource with `permissions:
   * true` is checked. Without it such a resource is refused.
   */
  readonly operations?: Readonly<
    Record<string, Partial<Record<AuthorizerOperation, Permission>>>
  >;
  /**
   * The membership source a stale or truncated token is re-read from, wrapped
   * in `claimsFirst(source, { onStale: 'reread', versions })`. `versions` is
   * the cache better-supabase passes at runtime (`createNext({ versions })`),
   * else the `versions` option.
   */
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /**
   * Reads the user's current authorization version, which `claimsFirst`
   * compares with the token's `authz_ver` claim; default the source's own
   * `version`. Pass `authzVersion({ query })` from `permdock/supabase`, which
   * reads `permdock_authz_version`, the table the token hook stamps `authz_ver`
   * from, when the membership source has no `version` of its own or reads
   * another one.
   */
  readonly version?: MembershipSource["version"];
  /**
   * The version cache for `memberships` when better-supabase passes none (a
   * server created without `versions`).
   */
  readonly versions?: VersionCache;
  /**
   * The intent of one check. By default better-supabase's `context.intent`;
   * without it a batch (`evaluations`, list and row filtering) and an action
   * named `read`, `list` or `view` are `read`, so `claimsFirst` may answer from
   * the version cache, and every other check is `write` and reads the version
   * live.
   */
  readonly intent?: (request: AuthorizationRequest<Permission>) => Intent;
  /**
   * The approval store an `approval-required` decision files its request in and
   * resumes from. The approval id the client sends (better-supabase's
   * `approval: { header }`) resumes one `evaluate` call; `evaluations` never
   * consumes it. Without a store, `approval-required` is returned as is.
   */
  readonly store?: ApprovalStore;
  /**
   * Shares instances across requests while the caller's authorization version
   * is unchanged: the `instanceCache()` the app's other adapters use.
   */
  readonly instances?: InstanceCache;
  /** Receives every error a check threw; the check still denies. */
  readonly onError?: BetterSupabaseOnError;
  /**
   * Sources and sinks for each instance. The subject, actor, tenant and intent
   * always come from the verified request.
   */
  readonly options?: Omit<
    PermDockOptions,
    "tenant" | "actor" | "delegation" | "session" | "expiresAt" | "intent"
  >;
};

const OPERATIONS: ReadonlySet<string> = new Set<AuthorizerOperation>([
  "list",
  "get",
  "create",
  "update",
  "delete",
]);

const READ_ACTIONS: ReadonlySet<string> = new Set(["read", "list", "view"]);

const denied = (reason: string): AuthorizationOutcome => ({
  outcome: "denied",
  reason,
});

function outcomeOf(decision: Decision, key: string): AuthorizationOutcome {
  switch (decision.outcome) {
    case "granted":
      return { outcome: "granted" };
    case "approval-required":
      return { outcome: "approval-required", approval: { id: decision.token } };
    case "denied":
      return denied(deniedMessage(key, decision));
    default: {
      const never: never = decision;
      return never;
    }
  }
}

/**
 * The row a check decides on. A write is `change`: a create checks the new
 * values, an update the stored row against the stored row with the new values
 * over it. Only a row better-supabase loaded itself, with no change, skips
 * schema validation.
 */
function dataOf(resource: AuthorizationResource): {
  readonly data: unknown;
  readonly trusted: boolean;
} {
  const { change } = resource;
  if (change !== undefined) {
    return change.current === undefined
      ? { data: change.next, trusted: false }
      : {
          data: {
            current: change.current,
            next: { ...change.current, ...change.next },
          },
          trusted: false,
        };
  }
  return { data: resource.properties, trusted: resource.source === "loaded" };
}

/**
 * The verified claims better-supabase passes in `subject.properties.claims`,
 * for a user or a delegated agent.
 */
function claimsOf(request: AuthorizationRequest<Permission>): unknown {
  const { subject } = request;
  if (subject.type !== "user" && subject.type !== "agent") return undefined;
  const claims = subject.properties?.["claims"];
  return isRecord(claims) ? claims : undefined;
}

const tenantOf = (request: AuthorizationRequest<Permission>): string | null => {
  const { tenant } = request.context;
  return typeof tenant === "string" ? tenant : null;
};

const keyOf = (request: AuthorizationRequest<Permission>): string | null =>
  isPermission(request.action) ? request.action.key : null;

/**
 * better-supabase's `authorizer` for PermDock: every resource, action, route
 * guard and MCP tool that declares a `permission` is decided with `decide`. The
 * subject is mapped from the verified claims with `subjectFromBetterSupabase`;
 * the request's `context.tenant` selects the active tenant only among the
 * memberships the claims hold. A caller without claims is anonymous, and a
 * throw denies. With better-supabase's runtime `memo`, the checks of one
 * request scope share an instance per claims, tenant and intent.
 */
export function authorizer(
  options: AuthorizerOptions,
): Authorizer<Permission, VersionCache> {
  const { operations, store } = options;
  const intentOf = (
    request: AuthorizationRequest<Permission>,
    batch: boolean,
  ): Intent => {
    if (options.intent !== undefined) return options.intent(request);
    const { intent } = request.context;
    if (intent === "read" || intent === "write") return intent;
    if (batch) return "read";
    return isPermission(request.action) &&
      READ_ACTIONS.has(request.action.action)
      ? "read"
      : "write";
  };
  const resolve = permdockResolver(options);
  const instanceFor = (
    claims: unknown,
    tenant: string | null,
    intent: Intent,
    runtime: AuthorizerRuntime<VersionCache> | undefined,
  ): Promise<PermDock> =>
    resolve(
      claims === undefined ? null : { kind: "user", claims },
      { tenant, intent },
      runtime?.versions,
    );
  const scoped = (
    claims: unknown,
    tenant: string | null,
    intent: Intent,
    runtime: AuthorizerRuntime<VersionCache> | undefined,
    batch?: Map<string, Promise<PermDock>>,
  ): Promise<PermDock> => {
    const key = `permdock:authorizer:${canonicalJson([claims ?? null, tenant, intent])}`;
    const build = (): Promise<PermDock> =>
      instanceFor(claims, tenant, intent, runtime);
    if (runtime?.memo !== undefined) return runtime.memo.once(key, build);
    if (batch === undefined) return build();
    const known = batch.get(key);
    if (known !== undefined) return known;
    const created = build();
    batch.set(key, created);
    return created;
  };
  const decideWith = async (
    permdock: PermDock,
    request: AuthorizationRequest<Permission>,
    consume: boolean,
  ): Promise<AuthorizationOutcome> => {
    const { action } = request;
    if (!isPermission(action)) return denied("Unknown permission.");
    const { data, trusted } = dataOf(request.resource);
    const decision = permdock.decide(action, data, {
      trusted,
      adapter: "better-supabase",
    });
    if (store === undefined || decision.outcome !== "approval-required") {
      return outcomeOf(decision, action.key);
    }
    const { id } = request.resource;
    const resumed = await resumeDecision({
      decision,
      permission: action,
      subject: permdock.subject,
      store,
      resource:
        id === undefined
          ? { type: action.resource }
          : { type: action.resource, id },
      adapter: "better-supabase",
      token: parseApprovalHeader(request.context.approval ?? null),
      consume,
    });
    return outcomeOf(resumed, action.key);
  };
  const failed = (
    error: unknown,
    request: AuthorizationRequest<Permission>,
  ): AuthorizationOutcome => {
    report(options.onError, error, {
      permission: keyOf(request),
      tenant: tenantOf(request),
    });
    return denied("The permission check failed.");
  };

  return Object.freeze({
    apiVersion: 1,
    name: "PermDock",
    key(ref: Permission): string {
      if (!isPermission(ref)) throw new TypeError("Not a PermDock permission");
      return ref.key;
    },
    ...(operations === undefined
      ? {}
      : {
          forOperation(
            table: string,
            operation: string,
          ): Permission | undefined {
            if (!OPERATIONS.has(operation) || !Object.hasOwn(operations, table))
              return undefined;
            // SAFETY: OPERATIONS holds exactly the AuthorizerOperation names.
            return operations[table]?.[operation as AuthorizerOperation];
          },
        }),
    async evaluate(
      request: AuthorizationRequest<Permission>,
      runtime?: AuthorizerRuntime<VersionCache>,
    ): Promise<AuthorizationOutcome> {
      try {
        return await decideWith(
          await scoped(
            claimsOf(request),
            tenantOf(request),
            intentOf(request, false),
            runtime,
          ),
          request,
          true,
        );
      } catch (error) {
        return failed(error, request);
      }
    },
    evaluations(
      requests: readonly AuthorizationRequest<Permission>[],
      runtime?: AuthorizerRuntime<VersionCache>,
    ): Promise<readonly AuthorizationOutcome[]> {
      const batch = new Map<string, Promise<PermDock>>();
      const shared = (
        request: AuthorizationRequest<Permission>,
      ): Promise<PermDock> =>
        scoped(
          claimsOf(request),
          tenantOf(request),
          intentOf(request, true),
          runtime,
          batch,
        );
      return Promise.all(
        requests.map(async (request) => {
          try {
            return await decideWith(await shared(request), request, false);
          } catch (error) {
            return failed(error, request);
          }
        }),
      );
    },
  } satisfies Authorizer<Permission, VersionCache>);
}
