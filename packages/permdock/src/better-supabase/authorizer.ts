import type {
  AuthorizationOutcome,
  AuthorizationRequest,
  Authorizer,
  AuthorizerRuntime,
} from "better-supabase/server";

import type { Decision } from "../core/decision.ts";
import type { Intent, MembershipSource } from "../core/interfaces.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { BetterSupabaseOnError } from "./report.ts";
import type { BetterSupabaseSubjectOptions } from "./subject.ts";

import { isRecord } from "../core/compact.ts";
import { claimsFirst } from "../core/memberships.ts";
import { getPermDock } from "../core/permdock.ts";
import { isPermission } from "../core/permission-registry.ts";
import { deniedMessage, report } from "./report.ts";
import { subjectFromBetterSupabase } from "./subject.ts";

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
   * The intent of one check. By default a batch (`evaluations`, list and row
   * filtering) and an action named `read`, `list` or `view` are `read`, so
   * `claimsFirst` may answer from the version cache; every other check is
   * `write` and reads the version live.
   */
  readonly intent?: (request: AuthorizationRequest<Permission>) => Intent;
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

function isVersionCache(value: unknown): value is VersionCache {
  return (
    isRecord(value) &&
    typeof value["maxStaleMs"] === "number" &&
    typeof value["current"] === "function" &&
    typeof value["evict"] === "function"
  );
}

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

function decideWith(
  permdock: PermDock,
  request: AuthorizationRequest<Permission>,
): AuthorizationOutcome {
  const { action } = request;
  if (!isPermission(action)) return denied("Unknown permission.");
  return outcomeOf(
    permdock.decide(action, request.resource.properties),
    action.key,
  );
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
export function authorizer(options: AuthorizerOptions): Authorizer<Permission> {
  const { operations } = options;
  const intentOf = (
    request: AuthorizationRequest<Permission>,
    batch: boolean,
  ): Intent => {
    if (options.intent !== undefined) return options.intent(request);
    if (batch) return "read";
    return isPermission(request.action) &&
      READ_ACTIONS.has(request.action.action)
      ? "read"
      : "write";
  };
  const membershipsFor = (
    runtime: AuthorizerRuntime | undefined,
  ): Pick<PermDockOptions, "memberships"> => {
    if (options.memberships === undefined) return {};
    const versions = isVersionCache(runtime?.versions)
      ? runtime.versions
      : options.versions;
    return {
      memberships: claimsFirst(options.memberships, {
        onStale: "reread",
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(versions === undefined ? {} : { versions }),
      }),
    };
  };
  const instanceFor = async (
    claims: unknown,
    tenant: string | null,
    intent: Intent,
    runtime: AuthorizerRuntime | undefined,
  ): Promise<PermDock> => {
    const session =
      claims === undefined ? null : { kind: "user" as const, claims };
    const base = await getPermDock(
      options.policy,
      subjectFromBetterSupabase(session, options.subject),
      { ...options.options, ...membershipsFor(runtime), intent },
    );
    return tenant === null ? base : base.tenant(tenant);
  };
  const scoped = (
    claims: unknown,
    tenant: string | null,
    intent: Intent,
    runtime: AuthorizerRuntime | undefined,
  ): Promise<PermDock> =>
    runtime?.memo === undefined
      ? instanceFor(claims, tenant, intent, runtime)
      : runtime.memo.once(
          `permdock:authorizer:${JSON.stringify([claims ?? null, tenant, intent])}`,
          () => instanceFor(claims, tenant, intent, runtime),
        );
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
      runtime?: AuthorizerRuntime,
    ): Promise<AuthorizationOutcome> {
      try {
        return decideWith(
          await scoped(
            claimsOf(request),
            tenantOf(request),
            intentOf(request, false),
            runtime,
          ),
          request,
        );
      } catch (error) {
        return failed(error, request);
      }
    },
    evaluations(
      requests: readonly AuthorizationRequest<Permission>[],
      runtime?: AuthorizerRuntime,
    ): Promise<readonly AuthorizationOutcome[]> {
      // A batch is one caller's rows, so one instance serves every request
      // that carries the same claims object, tenant and intent.
      const cache = new Map<unknown, Map<string, Promise<PermDock>>>();
      const shared = (
        request: AuthorizationRequest<Permission>,
      ): Promise<PermDock> => {
        const claims = claimsOf(request);
        const tenant = tenantOf(request);
        const intent = intentOf(request, true);
        let byKey = cache.get(claims);
        if (byKey === undefined) {
          byKey = new Map();
          cache.set(claims, byKey);
        }
        const key = JSON.stringify([tenant, intent]);
        let instance = byKey.get(key);
        if (instance === undefined) {
          instance = scoped(claims, tenant, intent, runtime);
          byKey.set(key, instance);
        }
        return instance;
      };
      return Promise.all(
        requests.map(async (request) => {
          try {
            return decideWith(await shared(request), request);
          } catch (error) {
            return failed(error, request);
          }
        }),
      );
    },
  } satisfies Authorizer<Permission>);
}
