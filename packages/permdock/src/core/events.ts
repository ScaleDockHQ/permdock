import type { CustomGrant } from "./custom-roles.ts";
import type { Decision } from "./decision.ts";
import type {
  AuthEvent,
  DecisionEvent,
  DecisionSink,
  LimitStore,
} from "./interfaces.ts";
import type { DecideOptions } from "./permdock.ts";
import type { Permission } from "./permissions.ts";
import type { Policy } from "./policy.ts";
import type { RelationReader } from "./relations.ts";
import type { CustomRole, Membership, Subject } from "./subject.ts";

import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { getResource } from "./permissions.ts";
import { isThenable } from "./thenable.ts";
import { wireDenials } from "./wire-denial.ts";

export type ListenerMap = {
  decision: Set<(event: DecisionEvent) => void>;
  denied: Set<(event: DecisionEvent) => void>;
  approval: Set<(payload: unknown) => void>;
  auth: Set<(event: AuthEvent) => void>;
  error: Set<(error: unknown) => void>;
};

export function emitSafe(
  listeners: Set<(payload: unknown) => void>,
  payload: unknown,
  errors: ListenerMap,
): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      for (const handler of errors.error) {
        try {
          handler(error);
        } catch {
          // ignore
        }
      }
    }
  }
}

export function emptyListeners(): ListenerMap {
  return {
    decision: new Set(),
    denied: new Set(),
    approval: new Set(),
    auth: new Set(),
    error: new Set(),
  };
}

export type EvalEnv = {
  readonly emit: boolean;
  readonly simulated: boolean;
  readonly skipAlternatives: boolean;
  readonly customRoles: readonly CustomRole[];
  readonly customGrants: readonly CustomGrant[];
  readonly listeners: ListenerMap;
  readonly sink: DecisionSink | undefined;
  readonly limits: LimitStore | undefined;
  readonly limitCache: Map<string, number>;
  readonly team: string | undefined;
  /** Relation facts, read through the instance's per-request cache. */
  readonly relations?: RelationReader;
};

function credentialRef(
  subject: Subject,
): NonNullable<DecisionEvent["subject"]["credential"]> | undefined {
  const value = subject.principal?.["credential"];
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  // SAFETY: value is a non-null object checked above; both fields stay unknown until checked.
  const { id, kind } = value as {
    readonly id?: unknown;
    readonly kind?: unknown;
  };
  return typeof id === "string" && (kind === "user" || kind === "service")
    ? { id, kind }
    : undefined;
}

export function finish(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  data: unknown,
  decision: Decision,
  options: DecideOptions,
  env: EvalEnv,
  trusted: boolean,
  membership?: Membership,
  counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  },
): void {
  const heard =
    env.sink !== undefined ||
    env.listeners.decision.size > 0 ||
    (decision.outcome === "denied" && env.listeners.denied.size > 0) ||
    (decision.outcome === "approval-required" &&
      env.listeners.approval.size > 0);
  if (!env.emit || !heard) {
    return;
  }
  const resource = getResource(policy.permissions, permission.resource);
  // SAFETY: data is a non-null object checked in the condition; the read value stays unknown.
  const resourceId =
    data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)[resource?.id ?? "id"]
      : undefined;
  // SAFETY: only the purpose array is checked; its items are not verified to be strings.
  const event: DecisionEvent = freezeDeep(
    compact<DecisionEvent>({
      type: "decision" as const,
      at: new Date().toISOString(),
      outcome: decision.outcome,
      permission: permission.key,
      scope: permission.scope,
      resource: compact<DecisionEvent["resource"]>({
        type: permission.resource,
        id: resourceId === undefined ? undefined : String(resourceId),
      }),
      subject: compact<DecisionEvent["subject"]>({
        principal:
          subject.principal === null
            ? null
            : compact<NonNullable<DecisionEvent["subject"]["principal"]>>({
                id: subject.principal.id,
                roles: subject.principal.roles ?? [],
                tenant: subject.principal.tenant,
              }),
        actor:
          subject.actor === undefined
            ? undefined
            : { id: subject.actor.id, kind: subject.actor.kind },
        delegation:
          subject.delegation === undefined
            ? undefined
            : compact<NonNullable<DecisionEvent["subject"]["delegation"]>>({
                scopes: subject.delegation.scopes,
                authorizationDetails: subject.delegation.authorizationDetails,
              }),
        credential: credentialRef(subject),
      }),
      tenant: subject.principal?.tenant,
      membership,
      via: membership?.via ?? null,
      matched:
        decision.outcome === "granted"
          ? compact({
              role: decision.matched.role,
              permission: decision.matched.permission,
              to: decision.matched.to,
              hosted: decision.matched.hosted,
              breakGlass: decision.matched.breakGlass,
            })
          : decision.outcome === "approval-required"
            ? compact({
                role: decision.grant.role,
                permission: decision.grant.permission,
                to: decision.grant.to,
                hosted: decision.grant.hosted,
              })
            : undefined,
      purpose:
        Array.isArray(subject.context["purpose"]) &&
        subject.context["purpose"].length > 0
          ? (subject.context["purpose"] as readonly string[])
          : undefined,
      reason:
        typeof subject.context["reason"] === "string" &&
        subject.context["reason"] !== ""
          ? subject.context["reason"]
          : undefined,
      denials:
        decision.outcome === "denied"
          ? wireDenials(decision.denials)
          : undefined,
      alternatives:
        decision.outcome === "denied"
          ? decision.alternatives.map((leaf) => leaf.key)
          : undefined,
      token:
        decision.outcome === "granted" ||
        decision.outcome === "approval-required"
          ? decision.token
          : undefined,
      trusted,
      source: options.source ?? "decide",
      adapter: options.adapter,
      counts,
    }),
  );
  // SAFETY: emitSafe passes these listeners only the DecisionEvent built above.
  emitSafe(
    env.listeners.decision as unknown as Set<(payload: unknown) => void>,
    event,
    env.listeners,
  );
  if (decision.outcome === "denied") {
    // SAFETY: emitSafe passes these listeners only the DecisionEvent built above.
    emitSafe(
      env.listeners.denied as unknown as Set<(payload: unknown) => void>,
      event,
      env.listeners,
    );
  }
  if (decision.outcome === "approval-required") {
    emitSafe(env.listeners.approval, event, env.listeners);
  }
  if (env.sink !== undefined) {
    try {
      const written = env.sink.write([event]);
      if (isThenable(written)) {
        void written.catch((error: unknown) => {
          emitSafe(env.listeners.error, error, env.listeners);
        });
      }
    } catch (error) {
      emitSafe(env.listeners.error, error, env.listeners);
    }
  }
}
