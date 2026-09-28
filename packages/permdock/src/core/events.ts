import type { Decision } from './decision.ts';
import type {
  AuthEvent,
  DecisionEvent,
  DecisionSink,
  LimitStore,
} from './interfaces.ts';
import type { DecideOptions } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Policy } from './policy.ts';
import type { CustomRole, Membership, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { getResource } from './permissions.ts';
import { isThenable } from './thenable.ts';

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
  readonly listeners: ListenerMap;
  readonly sink: DecisionSink | undefined;
  readonly limits: LimitStore | undefined;
  readonly limitCache: Map<string, number>;
  readonly team: string | undefined;
};

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
  if (!env.emit) {
    return;
  }
  const resource = getResource(policy.permissions, permission.resource);
  const resourceId =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)[resource?.id ?? 'id']
      : undefined;
  const event: DecisionEvent = freezeDeep(
    compact<DecisionEvent>({
      type: 'decision' as const,
      at: new Date().toISOString(),
      outcome: decision.outcome,
      permission: permission.key,
      scope: permission.scope,
      resource: compact<DecisionEvent['resource']>({
        type: permission.resource,
        id: resourceId === undefined ? undefined : String(resourceId),
      }),
      subject: compact<DecisionEvent['subject']>({
        principal:
          subject.principal === null
            ? null
            : compact<NonNullable<DecisionEvent['subject']['principal']>>({
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
            : compact<NonNullable<DecisionEvent['subject']['delegation']>>({
                scopes: subject.delegation.scopes,
                authorizationDetails: subject.delegation.authorizationDetails,
              }),
      }),
      tenant: subject.principal?.tenant,
      membership,
      via: membership?.via ?? null,
      matched:
        decision.outcome === 'granted'
          ? compact({
              role: decision.matched.role,
              permission: decision.matched.permission,
              to: decision.matched.to,
              hosted: decision.matched.hosted,
            })
          : decision.outcome === 'approval-required'
            ? compact({
                role: decision.grant.role,
                permission: decision.grant.permission,
                to: decision.grant.to,
                hosted: decision.grant.hosted,
              })
            : undefined,
      denials: decision.outcome === 'denied' ? decision.denials : undefined,
      alternatives:
        decision.outcome === 'denied'
          ? decision.alternatives.map((leaf) => leaf.key)
          : undefined,
      token:
        decision.outcome === 'granted' ||
        decision.outcome === 'approval-required'
          ? decision.token
          : undefined,
      trusted,
      source: options.source ?? 'decide',
      adapter: options.adapter,
      counts,
    }),
  );
  emitSafe(
    env.listeners.decision as unknown as Set<(payload: unknown) => void>,
    event,
    env.listeners,
  );
  if (decision.outcome === 'denied') {
    emitSafe(
      env.listeners.denied as unknown as Set<(payload: unknown) => void>,
      event,
      env.listeners,
    );
  }
  if (decision.outcome === 'approval-required') {
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
