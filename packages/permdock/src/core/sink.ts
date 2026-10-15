import type { AppData } from "./app-data.ts";
import type { Automation } from "./automation.ts";
import type { Credential } from "./credential.ts";
import type {
  AccessEvent,
  AutomationEvent,
  CredentialEvent,
  DecisionEvent,
  DeliveryEvent,
  DirectoryEvent,
  MembershipEvent,
  SinkEvent,
} from "./event-types.ts";
import type { DecisionSink, TokenSigner } from "./interfaces.ts";
import type { OperationRisk } from "./operation-risks.ts";
import type { SupportSession } from "./support-session.ts";

import { assertAppData } from "./app-data.ts";
import { compact } from "./compact.ts";
import { EVENT_SCHEMA_IDS } from "./event-schemas.ts";
import { requireEventInstant } from "./event-time.ts";

/**
 * The closed list of CloudEvents `type` values, `com.permdock.<family>` or
 * `com.permdock.<family>.<operation>`. `RESERVED_CLOUD_EVENT_TYPES` are named
 * for later releases and nothing emits them yet.
 */
export const CLOUD_EVENT_TYPES: {
  readonly decision: "com.permdock.decision";
  readonly approvalRequested: "com.permdock.approval.requested";
  readonly approvalResolved: "com.permdock.approval.resolved";
  readonly approvalExpired: "com.permdock.approval.expired";
  readonly approvalCancelled: "com.permdock.approval.cancelled";
  readonly membershipAdded: "com.permdock.membership.added";
  readonly membershipRemoved: "com.permdock.membership.removed";
  readonly membershipChanged: "com.permdock.membership.changed";
  readonly credentialCreated: "com.permdock.credential.created";
  readonly credentialUsed: "com.permdock.credential.used";
  readonly credentialRotated: "com.permdock.credential.rotated";
  readonly credentialRevoked: "com.permdock.credential.revoked";
  readonly directoryCreated: "com.permdock.directory.created";
  readonly directoryReplaced: "com.permdock.directory.replaced";
  readonly directoryPatched: "com.permdock.directory.patched";
  readonly directoryDeleted: "com.permdock.directory.deleted";
  readonly catalogPublished: "com.permdock.catalog.published";
  readonly catalogDrifted: "com.permdock.catalog.drifted";
  readonly supportSessionStarted: "com.permdock.support-session.started";
  readonly supportSessionEnded: "com.permdock.support-session.ended";
  readonly automationPublished: "com.permdock.automation.published";
  readonly automationChanged: "com.permdock.automation.changed";
  readonly automationRevoked: "com.permdock.automation.revoked";
  readonly automationRun: "com.permdock.automation.run";
  readonly deliverySent: "com.permdock.delivery.sent";
  readonly deliveryDelivered: "com.permdock.delivery.delivered";
  readonly deliveryBounced: "com.permdock.delivery.bounced";
  readonly deliveryComplained: "com.permdock.delivery.complained";
  readonly deliveryFailed: "com.permdock.delivery.failed";
} = Object.freeze({
  decision: "com.permdock.decision",
  approvalRequested: "com.permdock.approval.requested",
  approvalResolved: "com.permdock.approval.resolved",
  approvalExpired: "com.permdock.approval.expired",
  approvalCancelled: "com.permdock.approval.cancelled",
  membershipAdded: "com.permdock.membership.added",
  membershipRemoved: "com.permdock.membership.removed",
  membershipChanged: "com.permdock.membership.changed",
  credentialCreated: "com.permdock.credential.created",
  credentialUsed: "com.permdock.credential.used",
  credentialRotated: "com.permdock.credential.rotated",
  credentialRevoked: "com.permdock.credential.revoked",
  directoryCreated: "com.permdock.directory.created",
  directoryReplaced: "com.permdock.directory.replaced",
  directoryPatched: "com.permdock.directory.patched",
  directoryDeleted: "com.permdock.directory.deleted",
  catalogPublished: "com.permdock.catalog.published",
  catalogDrifted: "com.permdock.catalog.drifted",
  supportSessionStarted: "com.permdock.support-session.started",
  supportSessionEnded: "com.permdock.support-session.ended",
  automationPublished: "com.permdock.automation.published",
  automationChanged: "com.permdock.automation.changed",
  automationRevoked: "com.permdock.automation.revoked",
  automationRun: "com.permdock.automation.run",
  deliverySent: "com.permdock.delivery.sent",
  deliveryDelivered: "com.permdock.delivery.delivered",
  deliveryBounced: "com.permdock.delivery.bounced",
  deliveryComplained: "com.permdock.delivery.complained",
  deliveryFailed: "com.permdock.delivery.failed",
});

export type CloudEventType =
  (typeof CLOUD_EVENT_TYPES)[keyof typeof CLOUD_EVENT_TYPES];

/** Types named for a later release; a receiver refuses them until then. None are reserved now. */
export const RESERVED_CLOUD_EVENT_TYPES: readonly CloudEventType[] =
  Object.freeze([]);

/** The CloudEvents JSON format media type for one event (structured mode). */
export const CLOUDEVENTS_CONTENT_TYPE = "application/cloudevents+json";

/** The CloudEvents JSON batch format media type: a JSON array of events. */
export const CLOUDEVENTS_BATCH_CONTENT_TYPE =
  "application/cloudevents-batch+json";

/**
 * Why a published catalog drifted. The first four broke a live hosted grant,
 * which the Cloud then suspends; the `operation-*` codes only report.
 */
export type CatalogFindingCode =
  | "permission-removed"
  | "not-hostable"
  | "grantee-removed"
  | "approval-tightened"
  | "operation-risk-raised"
  | "operation-approval-removed";

/** One drift finding: the permission key and, when one broke, the hosted grant id. */
export type CatalogFinding = {
  readonly code: CatalogFindingCode;
  readonly permission: string;
  readonly grant?: string;
  /** The operation name, on the `operation-*` codes. */
  readonly operation?: string;
  /** `meta.risk` before the publish, on `operation-risk-raised`; an unset risk is `low`. */
  readonly previous?: OperationRisk;
  /** `meta.risk` after the publish, on `operation-risk-raised`. */
  readonly risk?: OperationRisk;
};

/** `data` of a `com.permdock.catalog.*` event: a `permdock cloud push` or a drift against live hosted grants. */
export type CatalogEventData = {
  readonly kind: "publish" | "drift";
  /** The catalog fingerprint after the publish, or the one drift was measured against. */
  readonly fingerprint: string;
  readonly previous?: string;
  readonly findings?: readonly CatalogFinding[];
};

/** A CloudEvents 1.0 event in the JSON format, with the distributed-tracing extension. */
export type CloudEvent = {
  readonly specversion: "1.0";
  readonly type: CloudEventType;
  /** An absolute URI naming the producer. */
  readonly source: string;
  readonly subject?: string;
  readonly id: string;
  /** An RFC 3339 instant: the sink event's `at`. */
  readonly time: string;
  readonly datacontenttype: "application/json";
  /** The published JSON Schema of `data`, `https://permdock.com/schemas/<family>-event-v1.json`. */
  readonly dataschema: string;
  /** W3C Trace Context `traceparent`, the CloudEvents distributed-tracing extension. */
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly data: SinkEvent | CatalogEventData;
};

export type CloudEventOptions = {
  /** An absolute URI naming the producer, such as the app's origin. */
  readonly source: string;
  /** Defaults to a random UUID. */
  readonly id?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
};

export type SignDecisionBatchOptions = {
  readonly audience?: string | readonly string[];
  /** An absolute URI naming the producer, the `source` of every CloudEvent. */
  readonly source: string;
};

export type MemoryDecisionSinkOptions = {
  readonly capacity?: number;
} & (
  | {
      readonly signer?: undefined;
      readonly audience?: undefined;
      readonly source?: undefined;
    }
  | {
      /** Signs each write as an evidence export of CloudEvents. */
      readonly signer: TokenSigner;
      readonly audience?: string | readonly string[];
      /** An absolute URI naming the producer, the `source` of every CloudEvent. */
      readonly source: string;
    }
);

export type MemoryDecisionSink = DecisionSink & {
  readonly events: () => readonly SinkEvent[];
  readonly batches: () => readonly string[];
};

const ABSOLUTE_URI = /^[A-Za-z][A-Za-z\d+.-]*:\S+$/u;
const TRACEPARENT = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u;

/** `true` for an RFC 3986 absolute URI: a scheme, a colon and no whitespace. */
export function isAbsoluteUri(value: unknown): value is string {
  return typeof value === "string" && ABSOLUTE_URI.test(value);
}

/** `true` for a W3C Trace Context `traceparent` whose ids are not all zero. */
export function isTraceparent(value: unknown): value is string {
  if (typeof value !== "string" || !TRACEPARENT.test(value)) {
    return false;
  }
  const [version, trace, span] = value.split("-");
  return (
    version !== "ff" && !/^0+$/u.test(trace ?? "") && !/^0+$/u.test(span ?? "")
  );
}

function approvalType(
  phase: NonNullable<DecisionEvent["phase"]>,
): CloudEventType {
  switch (phase) {
    case "requested":
      return CLOUD_EVENT_TYPES.approvalRequested;
    case "resolved":
      return CLOUD_EVENT_TYPES.approvalResolved;
    case "expired":
      return CLOUD_EVENT_TYPES.approvalExpired;
    case "cancelled":
      return CLOUD_EVENT_TYPES.approvalCancelled;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function directoryType(operation: DirectoryEvent["operation"]): CloudEventType {
  switch (operation) {
    case "create":
      return CLOUD_EVENT_TYPES.directoryCreated;
    case "replace":
      return CLOUD_EVENT_TYPES.directoryReplaced;
    case "patch":
      return CLOUD_EVENT_TYPES.directoryPatched;
    case "delete":
      return CLOUD_EVENT_TYPES.directoryDeleted;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function membershipType(
  operation: MembershipEvent["operation"],
): CloudEventType {
  switch (operation) {
    case "added":
      return CLOUD_EVENT_TYPES.membershipAdded;
    case "removed":
      return CLOUD_EVENT_TYPES.membershipRemoved;
    case "changed":
      return CLOUD_EVENT_TYPES.membershipChanged;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function credentialType(
  operation: CredentialEvent["operation"],
): CloudEventType {
  switch (operation) {
    case "created":
      return CLOUD_EVENT_TYPES.credentialCreated;
    case "used":
      return CLOUD_EVENT_TYPES.credentialUsed;
    case "rotated":
      return CLOUD_EVENT_TYPES.credentialRotated;
    case "revoked":
      return CLOUD_EVENT_TYPES.credentialRevoked;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function automationType(
  operation: AutomationEvent["operation"],
): CloudEventType {
  switch (operation) {
    case "published":
      return CLOUD_EVENT_TYPES.automationPublished;
    case "changed":
      return CLOUD_EVENT_TYPES.automationChanged;
    case "revoked":
      return CLOUD_EVENT_TYPES.automationRevoked;
    case "run":
      return CLOUD_EVENT_TYPES.automationRun;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function deliveryType(operation: DeliveryEvent["operation"]): CloudEventType {
  switch (operation) {
    case "sent":
      return CLOUD_EVENT_TYPES.deliverySent;
    case "delivered":
      return CLOUD_EVENT_TYPES.deliveryDelivered;
    case "bounced":
      return CLOUD_EVENT_TYPES.deliveryBounced;
    case "complained":
      return CLOUD_EVENT_TYPES.deliveryComplained;
    case "failed":
      return CLOUD_EVENT_TYPES.deliveryFailed;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/**
 * The CloudEvents `type` of a sink event. A support access event maps onto the
 * `support-session` family, and a consent the tenant pulls early (`revoked`)
 * ends the session like a lapse; `data.operation` keeps the difference.
 */
export function cloudEventType(event: SinkEvent): CloudEventType {
  switch (event.type) {
    case "directory":
      return directoryType(event.operation);
    case "membership":
      return membershipType(event.operation);
    case "credential":
      return credentialType(event.operation);
    case "access":
      return event.operation === "started"
        ? CLOUD_EVENT_TYPES.supportSessionStarted
        : CLOUD_EVENT_TYPES.supportSessionEnded;
    case "automation":
      return automationType(event.operation);
    case "delivery":
      return deliveryType(event.operation);
    case "decision":
      return event.phase === undefined
        ? CLOUD_EVENT_TYPES.decision
        : approvalType(event.phase);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function cloudEventSubject(event: SinkEvent): string {
  if (event.type === "directory") {
    return event.resource.id;
  }
  if (event.type === "membership" || event.type === "access") {
    return event.principal.id;
  }
  if (event.type === "credential") {
    return event.credential.id;
  }
  if (event.type === "delivery") {
    return event.delivery.id;
  }
  if (event.type === "automation") {
    return event.automation.id;
  }
  return event.permission;
}

/** `x` as given, after checking it is a plain JSON object; a builder throws on bad input. */
function checkedX(x: AppData | undefined): AppData | undefined {
  if (x !== undefined) {
    assertAppData(x, "x of a sink event");
  }
  return x;
}

/**
 * An `automation` sink event for `automation`. `run` carries the run id and
 * belongs on `run` events only.
 */
export function automationEvent(input: {
  readonly operation: AutomationEvent["operation"];
  readonly automation: Automation;
  readonly run?: string;
  readonly source?: string;
  readonly by?: AutomationEvent["by"];
  /** An RFC 3339 instant; defaults to now. */
  readonly at?: string;
  /** The application's own data; plain JSON, checked here. */
  readonly x?: AppData;
}): AutomationEvent {
  if ((input.run === undefined) !== (input.operation !== "run")) {
    throw new TypeError(
      "PermDock: automationEvent needs run on run events only",
    );
  }
  const { automation } = input;
  return compact<AutomationEvent>({
    type: "automation",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source ?? "permdock",
    operation: input.operation,
    automation: compact<AutomationEvent["automation"]>({
      id: automation.id,
      version: automation.version,
      mode: automation.mode,
      name: automation.name,
    }),
    principal: { id: automation.principal },
    publishedBy: automation.publishedBy,
    tenant: automation.tenant,
    roles: automation.roles,
    permissions: automation.permissions,
    run: input.run === undefined ? undefined : { id: input.run },
    by: input.by,
    x: checkedX(input.x),
  });
}

/**
 * The `access` event of a `SupportSession`: `started` when it begins,
 * `ended` when it lapses, `revoked` when it is ended early. `principal` is
 * the staff member, as for a support membership.
 */
export function supportSessionEvent(input: {
  readonly operation: AccessEvent["operation"];
  readonly session: SupportSession;
  readonly source?: string;
  /** An RFC 3339 instant; defaults to now. */
  readonly at?: string;
  /** The application's own data; plain JSON, checked here. */
  readonly x?: AppData;
}): AccessEvent {
  const { session } = input;
  return compact<AccessEvent>({
    type: "access",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source ?? "permdock",
    operation: input.operation,
    tenant: session.tenant,
    principal: { id: session.actor },
    via: "support-session",
    roles: [],
    expiresAt: requireEventInstant(session.expiresAt, "expiresAt"),
    grantedBy: session.approvedBy,
    reason: session.reason,
    session: { id: session.id, principal: session.principal },
    permissions: session.permissions,
    x: checkedX(input.x),
  });
}

/**
 * A `credential` sink event for `credential`. `sample` belongs on `used`
 * events only and must be in `(0, 1]`.
 */
export function credentialEvent(input: {
  readonly operation: CredentialEvent["operation"];
  readonly credential: Credential;
  readonly source?: string;
  readonly by?: CredentialEvent["by"];
  readonly sample?: number;
  /** An RFC 3339 instant; defaults to now. */
  readonly at?: string;
  /** The application's own data; plain JSON, checked here. */
  readonly x?: AppData;
}): CredentialEvent {
  const sample = input.sample;
  if (
    sample !== undefined &&
    (input.operation !== "used" ||
      !Number.isFinite(sample) ||
      sample <= 0 ||
      sample > 1)
  ) {
    throw new RangeError(
      "PermDock: sample is a number in (0, 1] on used events only",
    );
  }
  const { credential } = input;
  return compact<CredentialEvent>({
    type: "credential",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source ?? "permdock",
    operation: input.operation,
    credential: { id: credential.id, kind: credential.kind },
    principal: { id: credential.principal },
    tenant: credential.tenant,
    expiresAt: requireEventInstant(credential.expiresAt, "expiresAt"),
    by: input.by,
    sample,
    x: checkedX(input.x),
  });
}

export function membershipEvent(input: {
  readonly source: string;
  readonly operation: MembershipEvent["operation"];
  readonly principal: MembershipEvent["principal"];
  readonly scope?: string;
  readonly id?: string;
  readonly within?: MembershipEvent["within"];
  readonly via?: string;
  /** An RFC 3339 instant, or NumericDate seconds as a `Membership` holds them. */
  readonly expiresAt?: string | number;
  readonly roles: MembershipEvent["roles"];
  readonly by?: MembershipEvent["by"];
  /** An RFC 3339 instant; defaults to now. */
  readonly at?: string;
  /** The application's own data; plain JSON, checked here. */
  readonly x?: AppData;
}): MembershipEvent {
  if ((input.scope === undefined) !== (input.id === undefined)) {
    throw new TypeError(
      "PermDock: membershipEvent needs scope and id together",
    );
  }
  if (input.scope === undefined && input.within !== undefined) {
    throw new TypeError("PermDock: membershipEvent within needs a scope");
  }
  return compact<MembershipEvent>({
    type: "membership",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source,
    operation: input.operation,
    principal: input.principal,
    scope: input.scope,
    id: input.id,
    within: input.within,
    via: input.via,
    expiresAt: requireEventInstant(input.expiresAt, "expiresAt"),
    roles: input.roles,
    by: input.by,
    x: checkedX(input.x),
  });
}

/**
 * A support-access lifecycle event. `started` on consent, `ended` when the
 * session lapses, `revoked` when the tenant pulls consent early. It never
 * decides; the app writes and revokes the membership.
 */
export function accessEvent(input: {
  readonly source: string;
  readonly operation: AccessEvent["operation"];
  readonly tenant: string;
  readonly principal: AccessEvent["principal"];
  readonly via?: string;
  readonly roles: readonly string[];
  readonly member?: AccessEvent["member"];
  /** An RFC 3339 instant, or NumericDate seconds as a `Membership` holds them. */
  readonly expiresAt?: string | number;
  readonly grantedBy?: string;
  readonly reason?: string;
  readonly actor?: AccessEvent["actor"];
  /** An RFC 3339 instant; defaults to now. */
  readonly at?: string;
  /** The application's own data; plain JSON, checked here. */
  readonly x?: AppData;
}): AccessEvent {
  return compact<AccessEvent>({
    type: "access",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source,
    operation: input.operation,
    tenant: input.tenant,
    principal: input.principal,
    via: input.via ?? "support",
    roles: input.roles,
    member: input.member,
    expiresAt: requireEventInstant(input.expiresAt, "expiresAt"),
    grantedBy: input.grantedBy,
    reason: input.reason,
    actor: input.actor,
    x: checkedX(input.x),
  });
}

/**
 * Wraps a sink event in a CloudEvents 1.0 envelope. Throws a `TypeError` when
 * `source` is not an absolute URI or `traceparent` is not W3C Trace Context.
 */
export function toCloudEvent(
  event: SinkEvent,
  options: CloudEventOptions,
): CloudEvent {
  if (!isAbsoluteUri(options.source)) {
    throw new TypeError("PermDock: a CloudEvents source is an absolute URI");
  }
  if (
    options.traceparent !== undefined &&
    !isTraceparent(options.traceparent)
  ) {
    throw new TypeError("PermDock: traceparent is not W3C Trace Context");
  }
  return compact<CloudEvent>({
    specversion: "1.0",
    type: cloudEventType(event),
    source: options.source,
    subject: cloudEventSubject(event),
    id: options.id ?? globalThis.crypto.randomUUID(),
    time: event.at,
    datacontenttype: "application/json",
    dataschema: EVENT_SCHEMA_IDS[event.type],
    traceparent: options.traceparent,
    tracestate:
      options.traceparent === undefined ? undefined : options.tracestate,
    data: event,
  });
}

/**
 * Signs sink events as an offline evidence export: a compact JWS with
 * `typ: vnd.permdock.evidence+jwt` whose `events` claim holds CloudEvents.
 * Live deliveries use Standard Webhooks instead.
 */
export function signDecisionBatch(
  events: readonly SinkEvent[],
  signer: TokenSigner,
  options: SignDecisionBatchOptions,
): Promise<string> {
  const source = options.source;
  return signer.sign(
    { events: events.map((event) => toCloudEvent(event, { source })) },
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "vnd.permdock.evidence+jwt",
      audience: options.audience,
    }),
  );
}

export function memoryDecisionSink(
  options: MemoryDecisionSinkOptions = {},
): MemoryDecisionSink {
  const capacity = options.capacity ?? 10_000;
  const buffer: SinkEvent[] = [];
  const signed: string[] = [];
  if (options.signer !== undefined && !isAbsoluteUri(options.source)) {
    throw new TypeError("PermDock: a CloudEvents source is an absolute URI");
  }
  return {
    write(events: readonly SinkEvent[]): void | Promise<void> {
      buffer.push(...events);
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity);
      }
      if (options.signer === undefined) {
        return;
      }
      return signDecisionBatch(
        events,
        options.signer,
        compact<SignDecisionBatchOptions>({
          audience: options.audience,
          source: options.source,
        }),
      )
        .then((batch) => {
          signed.push(batch);
        })
        .catch(() => undefined);
    },
    events(): readonly SinkEvent[] {
      return [...buffer];
    },
    batches(): readonly string[] {
      return [...signed];
    },
  };
}
