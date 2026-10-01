import type { AccessEvent, DecisionEvent } from './interfaces.ts';

import { compact } from './compact.ts';

/** The OCSF schema version `toOcsf` emits. */
export const OCSF_VERSION = '1.3.0';

/** An OCSF Authorize Session (class 3003, category Identity and Access Management) event. */
export type OcsfAuthorizeSession = {
  readonly class_uid: 3003;
  readonly category_uid: 3;
  readonly activity_id: 1;
  readonly type_uid: 300301;
  readonly severity_id: 1 | 4;
  readonly time: number;
  readonly status_id: 0 | 1 | 2 | 99;
  readonly status: 'Unknown' | 'Success' | 'Failure' | 'Other';
  readonly status_detail?: string;
  readonly message: string;
  readonly privileges: readonly string[];
  /** OCSF requires `user`; an anonymous subject is `{ name: 'anonymous' }`. */
  readonly user: { readonly uid: string } | { readonly name: 'anonymous' };
  readonly actor?: {
    readonly user?: { readonly uid: string };
    readonly app_name?: string;
  };
  readonly metadata: {
    readonly version: typeof OCSF_VERSION;
    readonly product: {
      readonly name: 'PermDock';
      readonly vendor_name: 'PermDock';
      readonly feature?: { readonly name: string };
    };
    readonly tenant_uid?: string;
    readonly correlation_uid?: string;
  };
  readonly unmapped: {
    readonly outcome: DecisionEvent['outcome'];
    readonly scope: string;
    readonly resource: DecisionEvent['resource'];
    readonly source: DecisionEvent['source'];
    readonly phase?: DecisionEvent['phase'];
    readonly role?: string | null;
    readonly via?: string | null;
    /** Set high-severity break-glass events apart in a SIEM. */
    readonly breakGlass?: true;
    readonly purpose?: readonly string[];
    readonly reason?: string;
  };
};

function status(
  outcome: DecisionEvent['outcome'],
): Pick<OcsfAuthorizeSession, 'status_id' | 'status'> {
  switch (outcome) {
    case 'granted':
      return { status_id: 1, status: 'Success' };
    case 'denied':
      return { status_id: 2, status: 'Failure' };
    case 'approval-required':
      return { status_id: 99, status: 'Other' };
    default: {
      const exhaustive: never = outcome;
      return unknownStatus(exhaustive);
    }
  }
}

/** An outcome this build does not know, from a newer producer, is reported as OCSF Unknown. */
function unknownStatus(
  _outcome: never,
): Pick<OcsfAuthorizeSession, 'status_id' | 'status'> {
  return { status_id: 0, status: 'Unknown' };
}

/** Projects a decision or approval event onto OCSF Authorize Session; the event itself is unchanged. */
export function toOcsf(event: DecisionEvent): OcsfAuthorizeSession {
  const principal = event.subject.principal;
  const actor = event.subject.actor;
  const breakGlass = event.matched?.breakGlass === true;
  const detail =
    event.outcome === 'approval-required'
      ? 'approval-required'
      : event.denials?.map((denial) => denial.reason).join(',');
  const time = Date.parse(event.at);
  return compact<OcsfAuthorizeSession>({
    class_uid: 3003,
    category_uid: 3,
    activity_id: 1,
    type_uid: 300301,
    severity_id: breakGlass ? 4 : 1,
    time: Number.isNaN(time) ? 0 : time,
    ...status(event.outcome),
    status_detail: detail === '' ? undefined : detail,
    message: `${event.permission} ${event.outcome}`,
    privileges: [event.permission],
    user:
      principal === null
        ? { name: 'anonymous' as const }
        : { uid: principal.id },
    actor:
      actor === undefined
        ? undefined
        : compact({
            user: principal === null ? undefined : { uid: principal.id },
            app_name: actor.id,
          }),
    metadata: compact({
      version: OCSF_VERSION,
      product: compact({
        name: 'PermDock' as const,
        vendor_name: 'PermDock' as const,
        feature:
          event.adapter === undefined ? undefined : { name: event.adapter },
      }),
      tenant_uid: event.tenant,
      correlation_uid: event.token,
    }),
    unmapped: compact({
      outcome: event.outcome,
      scope: event.scope,
      resource: event.resource,
      source: event.source,
      phase: event.phase,
      role: event.matched?.role,
      via: event.via,
      breakGlass: breakGlass ? (true as const) : undefined,
      purpose: event.purpose,
      reason: event.reason,
    }),
  });
}

/**
 * An OCSF Account Change (class 3001) event for a support-access lifecycle
 * event: `started` enables the session, `ended` and `revoked` disable it.
 * Support access is high severity, so a SIEM can alert on vendor access.
 */
export type OcsfAccountChange = {
  readonly class_uid: 3001;
  readonly category_uid: 3;
  /** 2 Enable for `started`, 5 Disable for `ended` and `revoked`. */
  readonly activity_id: 2 | 5;
  readonly type_uid: 300102 | 300105;
  readonly severity_id: 4;
  readonly time: number;
  readonly message: string;
  readonly user: { readonly uid: string };
  readonly actor?: { readonly user?: { readonly uid: string } };
  readonly metadata: {
    readonly version: typeof OCSF_VERSION;
    readonly product: {
      readonly name: 'PermDock';
      readonly vendor_name: 'PermDock';
    };
    readonly tenant_uid: string;
  };
  readonly unmapped: {
    readonly operation: AccessEvent['operation'];
    readonly via: string;
    readonly roles: readonly string[];
    readonly member?: { readonly group: string };
    readonly grantedBy?: string;
    readonly reason?: string;
  };
};

export function accessToOcsf(event: AccessEvent): OcsfAccountChange {
  const time = Date.parse(event.at);
  const enable = event.operation === 'started';
  return compact<OcsfAccountChange>({
    class_uid: 3001,
    category_uid: 3,
    activity_id: enable ? 2 : 5,
    type_uid: enable ? 300102 : 300105,
    severity_id: 4,
    time: Number.isNaN(time) ? 0 : time,
    message: `support access ${event.operation}`,
    user: { uid: event.principal.id },
    actor:
      event.actor === undefined ? undefined : { user: { uid: event.actor.id } },
    metadata: {
      version: OCSF_VERSION,
      product: { name: 'PermDock' as const, vendor_name: 'PermDock' as const },
      tenant_uid: event.tenant,
    },
    unmapped: compact({
      operation: event.operation,
      via: event.via,
      roles: event.roles,
      member: event.member,
      grantedBy: event.grantedBy,
      reason: event.reason,
    }),
  });
}
