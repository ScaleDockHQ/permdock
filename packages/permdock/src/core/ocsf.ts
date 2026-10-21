import type { AccessEvent, DecisionEvent } from "./event-types.ts";

import { compact } from "./compact.ts";

/** The OCSF schema version `toOcsf` emits. */
export const OCSF_VERSION = "1.9.0";

/**
 * An OCSF Authorize Session (class 3003, category Identity and Access
 * Management) event. API Activity (6003) would fit a per-request decision, but
 * it requires `api` and `src_endpoint`, which a decision event does not carry.
 */
export type OcsfAuthorizeSession = {
  readonly class_uid: 3003;
  readonly category_uid: 3;
  readonly activity_id: 1;
  readonly type_uid: 300301;
  readonly severity_id: 1 | 4;
  readonly time: number;
  readonly status_id: 0 | 1 | 2 | 99;
  /** OCSF requires a source label for status 99: `Approval Required`. */
  readonly status: "Unknown" | "Success" | "Failure" | "Approval Required";
  readonly status_detail?: string;
  readonly message: string;
  readonly privileges: readonly string[];
  /** OCSF requires `user`; an anonymous subject is `{ name: 'anonymous' }`. */
  readonly user: { readonly uid: string } | { readonly name: "anonymous" };
  readonly actor?: {
    readonly user?: { readonly uid: string };
    readonly app_name?: string;
  };
  readonly metadata: {
    readonly version: typeof OCSF_VERSION;
    readonly product: {
      readonly name: "PermDock";
      readonly vendor_name: "PermDock";
      readonly feature?: { readonly name: string };
    };
    readonly tenant_uid?: string;
    readonly correlation_uid?: string;
  };
  readonly unmapped: {
    readonly outcome: DecisionEvent["outcome"];
    readonly scope: string;
    readonly resource: DecisionEvent["resource"];
    readonly call: DecisionEvent["call"];
    readonly phase?: DecisionEvent["phase"];
    readonly role?: string | null;
    /** The matched grant's declared `name`. */
    readonly grant?: string;
    /** The names of the app obligations the decision carries. */
    readonly obligations?: readonly string[];
    readonly via?: string | null;
    /** Set high-severity break-glass events apart in a SIEM. */
    readonly breakGlass?: true;
    readonly purpose?: readonly string[];
    readonly reason?: string;
  };
};

function status(
  outcome: DecisionEvent["outcome"],
): Pick<OcsfAuthorizeSession, "status_id" | "status"> {
  switch (outcome) {
    case "granted":
      return { status_id: 1, status: "Success" };
    case "denied":
      return { status_id: 2, status: "Failure" };
    case "approval-required":
      return { status_id: 99, status: "Approval Required" };
    default: {
      const exhaustive: never = outcome;
      return unknownStatus(exhaustive);
    }
  }
}

/**
 * An outcome this build does not know, from a newer producer, is reported as
 * OCSF Unknown.
 */
function unknownStatus(
  _outcome: never,
): Pick<OcsfAuthorizeSession, "status_id" | "status"> {
  return { status_id: 0, status: "Unknown" };
}

/**
 * The names of a decision event's app obligations, or `undefined` when it has
 * none.
 */
export function appObligationNames(
  event: DecisionEvent,
): readonly string[] | undefined {
  const names = (event.obligations ?? []).flatMap((obligation) =>
    obligation.kind === "app" ? [obligation.name] : [],
  );
  return names.length === 0 ? undefined : names;
}

/**
 * Epoch milliseconds of an RFC 3339 `at`, or `undefined` when it does not
 * parse.
 */
function epochMillis(at: string): number | undefined {
  const time = Date.parse(at);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Projects a decision or approval event onto OCSF Authorize Session; the event
 * itself is unchanged. An event whose `at` does not parse has no OCSF `time`
 * and projects to `undefined`.
 */
export function toOcsf(event: DecisionEvent): OcsfAuthorizeSession | undefined {
  const time = epochMillis(event.at);
  if (time === undefined) {
    return undefined;
  }
  const principal = event.subject.principal;
  const actor = event.subject.actor;
  const breakGlass = event.matched?.breakGlass === true;
  const detail =
    event.outcome === "approval-required"
      ? "approval-required"
      : event.denials?.map((denial) => denial.reason).join(",");
  return compact<OcsfAuthorizeSession>({
    class_uid: 3003,
    category_uid: 3,
    activity_id: 1,
    type_uid: 300301,
    severity_id: breakGlass ? 4 : 1,
    time,
    ...status(event.outcome),
    status_detail: detail === "" ? undefined : detail,
    message: `${event.permission} ${event.outcome}`,
    privileges: [event.permission],
    user:
      principal === null
        ? { name: "anonymous" as const }
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
        name: "PermDock" as const,
        vendor_name: "PermDock" as const,
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
      call: event.call,
      phase: event.phase,
      role: event.matched?.role,
      grant: event.matched?.name,
      obligations: appObligationNames(event),
      via: event.via,
      breakGlass: breakGlass ? (true as const) : undefined,
      purpose: event.purpose,
      reason: event.reason,
    }),
  });
}

/**
 * An OCSF User Management (class 3007) event for a support-access lifecycle
 * event: `started` enables the session, `ended` and `revoked` disable it.
 * Support access is high severity, so a SIEM can alert on vendor access. OCSF
 * 1.9.0 deprecates Account Change (3001) in favour of this class.
 */
export type OcsfUserManagement = {
  readonly class_uid: 3007;
  readonly category_uid: 3;
  /** 4 Enable for `started`, 5 Disable for `ended` and `revoked`. */
  readonly activity_id: 4 | 5;
  readonly type_uid: 300704 | 300705;
  readonly severity_id: 4;
  readonly time: number;
  readonly message: string;
  readonly user: { readonly uid: string };
  readonly actor?: { readonly user?: { readonly uid: string } };
  readonly metadata: {
    readonly version: typeof OCSF_VERSION;
    readonly product: {
      readonly name: "PermDock";
      readonly vendor_name: "PermDock";
    };
    readonly tenant_uid: string;
  };
  readonly unmapped: {
    readonly operation: AccessEvent["operation"];
    readonly via: string;
    readonly roles: readonly string[];
    readonly member?: { readonly group: string };
    readonly grantedBy?: string;
    readonly reason?: string;
  };
};

/** An access event whose `at` does not parse projects to `undefined`. */
export function accessToOcsf(
  event: AccessEvent,
): OcsfUserManagement | undefined {
  const time = epochMillis(event.at);
  if (time === undefined) {
    return undefined;
  }
  const enable = event.operation === "started";
  return compact<OcsfUserManagement>({
    class_uid: 3007,
    category_uid: 3,
    activity_id: enable ? 4 : 5,
    type_uid: enable ? 300704 : 300705,
    severity_id: 4,
    time,
    message: `support access ${event.operation}`,
    user: { uid: event.principal.id },
    actor:
      event.actor === undefined ? undefined : { user: { uid: event.actor.id } },
    metadata: {
      version: OCSF_VERSION,
      product: { name: "PermDock" as const, vendor_name: "PermDock" as const },
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
