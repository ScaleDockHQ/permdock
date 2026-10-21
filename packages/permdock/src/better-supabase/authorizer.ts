import type {
  AuthorizationOutcome,
  AuthorizationRequest,
  Authorizer,
} from "better-supabase/server";

import type { Decision } from "../core/decision.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";

import { isRecord } from "../core/compact.ts";
import { getPermDock } from "../core/permdock.ts";
import { isPermission } from "../core/permission-registry.ts";
import {
  type BetterSupabaseSubjectOptions,
  subjectFromBetterSupabase,
} from "./subject.ts";

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
   * Sources and sinks for each instance. The subject, actor and tenant always
   * come from the verified request.
   */
  readonly options?: Omit<
    PermDockOptions,
    "tenant" | "actor" | "delegation" | "session" | "expiresAt"
  >;
};

const OPERATIONS: ReadonlySet<string> = new Set<AuthorizerOperation>([
  "list",
  "get",
  "create",
  "update",
  "delete",
]);

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
    case "denied": {
      const why = decision.denials[0]?.reason;
      return denied(
        why === undefined
          ? `PermDock denied ${key}.`
          : `PermDock denied ${key}: ${why}.`,
      );
    }
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

/**
 * better-supabase's `authorizer` for PermDock: every resource, action, route
 * guard and MCP tool that declares a `permission` is decided with `decide`. The
 * subject is mapped from the verified claims with `subjectFromBetterSupabase`;
 * the request's `context.tenant` selects the active tenant only among the
 * memberships the claims hold. A caller without claims is anonymous, and a
 * throw denies.
 */
export function authorizer(options: AuthorizerOptions): Authorizer<Permission> {
  const { operations } = options;
  const instanceFor = async (
    claims: unknown,
    tenant: unknown,
  ): Promise<PermDock> => {
    const session =
      claims === undefined ? null : { kind: "user" as const, claims };
    const base = await getPermDock(
      options.policy,
      subjectFromBetterSupabase(session, options.subject),
      options.options,
    );
    return typeof tenant === "string" ? base.tenant(tenant) : base;
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
    async evaluate(request): Promise<AuthorizationOutcome> {
      try {
        return decideWith(
          await instanceFor(claimsOf(request), request.context["tenant"]),
          request,
        );
      } catch {
        return denied("The permission check failed.");
      }
    },
    evaluations(requests): Promise<readonly AuthorizationOutcome[]> {
      // A batch is one caller's rows, so one instance serves every request
      // that carries the same claims object and tenant.
      const cache = new Map<unknown, Map<unknown, Promise<PermDock>>>();
      const shared = (claims: unknown, tenant: unknown): Promise<PermDock> => {
        let byTenant = cache.get(claims);
        if (byTenant === undefined) {
          byTenant = new Map();
          cache.set(claims, byTenant);
        }
        let instance = byTenant.get(tenant);
        if (instance === undefined) {
          instance = instanceFor(claims, tenant);
          byTenant.set(tenant, instance);
        }
        return instance;
      };
      return Promise.all(
        requests.map(async (request) => {
          try {
            return decideWith(
              await shared(claimsOf(request), request.context["tenant"]),
              request,
            );
          } catch {
            return denied("The permission check failed.");
          }
        }),
      );
    },
  } satisfies Authorizer<Permission>);
}
