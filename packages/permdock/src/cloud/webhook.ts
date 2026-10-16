import type {
  AccessEvent,
  AutomationEvent,
  CredentialEvent,
  DecisionEvent,
  DeliveryEvent,
  DirectoryEvent,
  MembershipEvent,
} from "../core/event-types.ts";
import type {
  CLOUD_EVENT_TYPES,
  CatalogEventData,
  CloudEvent,
  CloudEventType,
} from "../core/sink.ts";
import type { Instant } from "../core/time.ts";
import type {
  WebhookFailureCause as MessageFailureCause,
  WebhookJwks,
  WebhookVerifier,
  WebhookVerifierOptions,
} from "../server/standard-webhooks.ts";
import type { ReplayStore } from "../ssf/types.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import {
  parseCloudEventBatch,
  parseCloudEvent as parseCoreCloudEvent,
} from "../core/parse-sink-events.ts";
import { webhookVerifier } from "../server/standard-webhooks.ts";

type Envelope<TType extends CloudEventType, TData> = Omit<
  CloudEvent,
  "type" | "data"
> & {
  readonly type: TType;
  readonly data: TData;
};

type Types = typeof CLOUD_EVENT_TYPES;

/** A CloudEvent PermDock Cloud delivers, discriminated by `type`. */
export type PermDockCloudEvent =
  | Envelope<Types["decision"], DecisionEvent>
  | Envelope<
      | Types["approvalRequested"]
      | Types["approvalResolved"]
      | Types["approvalExpired"]
      | Types["approvalCancelled"],
      DecisionEvent
    >
  | Envelope<
      | Types["directoryCreated"]
      | Types["directoryReplaced"]
      | Types["directoryPatched"]
      | Types["directoryDeleted"],
      DirectoryEvent
    >
  | Envelope<
      | Types["membershipAdded"]
      | Types["membershipRemoved"]
      | Types["membershipChanged"],
      MembershipEvent
    >
  | Envelope<
      | Types["credentialCreated"]
      | Types["credentialUsed"]
      | Types["credentialRotated"]
      | Types["credentialRevoked"],
      CredentialEvent
    >
  | Envelope<
      Types["catalogPublished"] | Types["catalogDrifted"],
      CatalogEventData
    >
  | Envelope<
      Types["supportSessionStarted"] | Types["supportSessionEnded"],
      AccessEvent
    >
  | Envelope<
      | Types["automationPublished"]
      | Types["automationChanged"]
      | Types["automationRevoked"]
      | Types["automationRun"],
      AutomationEvent
    >
  | Envelope<
      | Types["deliverySent"]
      | Types["deliveryDelivered"]
      | Types["deliveryBounced"]
      | Types["deliveryComplained"]
      | Types["deliveryFailed"],
      DeliveryEvent
    >;

export type WebhookOptions = {
  /**
   * A verifier to reuse across deliveries, so the JWKS is fetched once;
   * built from `jwks`, `secret`, `replay`, `tolerance` and `now` when absent.
   */
  readonly verifier?: WebhookVerifier;
  /** `cloud().jwks`, a JWKS URL or an inline key set, for `v1a` signatures. */
  readonly jwks?: WebhookJwks;
  /** The endpoint's `whsec_` secret, for `v1` signatures. */
  readonly secret?: string | readonly string[];
  /** Records each `webhook-id`; required unless `verifier` is set. */
  readonly replay?: ReplayStore;
  /** Seconds a timestamp may differ from the clock. Defaults to 300. */
  readonly tolerance?: number;
  readonly now?: () => Instant;
  readonly fetch?: typeof fetch;
};

/** The Standard Webhooks verifier's cause, or `invalid-events` for a signed body that is not a CloudEvents batch. */
export type WebhookFailureCause = MessageFailureCause | "invalid-events";

export type VerifiedWebhook =
  | {
      readonly ok: true;
      /** The `webhook-id`, unique per message across retries. */
      readonly id: string;
      /** The `webhook-timestamp` as an RFC 3339 instant. */
      readonly timestamp: string;
      readonly events: readonly PermDockCloudEvent[];
    }
  | { readonly ok: false; readonly cause: WebhookFailureCause };

/**
 * Validates one CloudEvent against the closed type list, its `dataschema` and
 * its data shape; returns `null` for anything else, never throws.
 */
export function parseCloudEvent(value: unknown): PermDockCloudEvent | null {
  // SAFETY: parseCoreCloudEvent checked that data matches the family its type names.
  return parseCoreCloudEvent(value) as PermDockCloudEvent | null;
}

function verifierFor(options: WebhookOptions): WebhookVerifier | undefined {
  if (options.verifier !== undefined) {
    return options.verifier;
  }
  if (
    options.replay === undefined ||
    (options.jwks === undefined && options.secret === undefined)
  ) {
    return undefined;
  }
  try {
    return webhookVerifier(
      compact<WebhookVerifierOptions>({
        jwks: options.jwks,
        secret: options.secret,
        replay: options.replay,
        tolerance: options.tolerance,
        now: options.now,
        fetch: options.fetch,
      }),
    );
  } catch {
    return undefined;
  }
}

function eventsOf(body: string): readonly PermDockCloudEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    const single = parseCloudEvent(parsed);
    return single === null ? null : [single];
  }
  // SAFETY: parseCloudEventBatch checked each event's data against the family its type names.
  return parseCloudEventBatch(parsed) as readonly PermDockCloudEvent[] | null;
}

/**
 * Verifies a PermDock Cloud webhook delivery: Standard Webhooks headers over
 * an `application/cloudevents-batch+json` body (or one
 * `application/cloudevents+json` event). There is no unsigned mode, and it
 * never throws.
 */
export async function verifyWebhook(
  request: Request,
  options: WebhookOptions,
): Promise<VerifiedWebhook> {
  const verifier = verifierFor(options);
  if (verifier === undefined) {
    return { ok: false, cause: "keys-unavailable" };
  }
  const verified = await verifier.verify(request);
  if (!verified.ok) {
    return { ok: false, cause: verified.cause };
  }
  const events = eventsOf(verified.body);
  if (events === null) {
    return { ok: false, cause: "invalid-events" };
  }
  return freezeDeep({
    ok: true as const,
    id: verified.id,
    timestamp: verified.timestamp,
    events,
  });
}
