import type { Decision, GrantedDecision } from "../core/decision.ts";
import type { DeliveryEvent } from "../core/event-types.ts";
import type { DecisionSink } from "../core/interfaces.ts";
import type { Operation } from "../core/operations.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type { Principal } from "../core/subject.ts";
import type {
  DeliverOptions,
  DeliveryChannel,
  DeliveryFailureCause,
  DeliveryMessages,
  DeliveryReport,
  DeliveryResult,
  DeliveryTarget,
  DeliveryTransport,
  DeliveryTransports,
  Recipient,
} from "./types.ts";

import { ownRecord } from "../core/capability.ts";
import { compact } from "../core/compact.ts";
import { deliveryEvent } from "../core/delivery-event.ts";
import { freezeDeep } from "../core/freeze.ts";
import { loadPrincipalByIdentity } from "../core/principal-source.ts";
import { outgoingEmail } from "./email.ts";
import {
  idempotencyKeyFor,
  isAddrSpec,
  isChatAddress,
  isWebhookAddress,
} from "./target.ts";

export type DeliveryPermDockOptions = {
  readonly transports: DeliveryTransports;
  /** Resolves `{ address }` recipients through `principalByIdentity`. */
  readonly principals?: PrincipalSource;
  /** Receives one `delivery` event per recipient. A throw is ignored. */
  readonly sink?: DecisionSink;
  /** The `from` of an email whose message sets none. */
  readonly from?: string;
  /** The event `source`; defaults to `permdock`. */
  readonly source?: string;
};

export type DeliveryPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /**
   * Checks every recipient against `target`'s permission on `row` with
   * `permdock.decideFor`, routes the granted ones to the transport of their
   * channel, and writes one `delivery` event per recipient. Never rejects:
   * a refused recipient or a transport error is a `failed` event.
   */
  readonly deliver: (
    permdock: PermDock<V>,
    target: Permission | Pick<Operation, "name" | "permission">,
    row: unknown,
    recipients: readonly Recipient[],
    messages: Partial<DeliveryMessages>,
    options?: DeliverOptions,
  ) => Promise<DeliveryReport>;
};

const CHANNELS: ReadonlySet<string> = new Set(["email", "chat", "webhook"]);

type Checked = {
  readonly channel: DeliveryChannel;
  readonly address: string;
  readonly principal?: string;
  readonly provider?: string;
  readonly workspace?: string;
  readonly trusted: boolean;
};

type Failure = {
  readonly cause: DeliveryFailureCause;
  readonly retryable: boolean;
  readonly reason?: string;
};

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value !== "" ? value : null;
}

/** The recipient in the form its channel compares, or `null` when it is malformed. */
function checkRecipient(value: unknown): Checked | null {
  const record = ownRecord(value);
  const channel = record?.["channel"];
  const raw = record?.["address"];
  if (
    record === undefined ||
    typeof channel !== "string" ||
    !CHANNELS.has(channel) ||
    typeof raw !== "string"
  ) {
    return null;
  }
  const principal = optionalString(record["principal"]);
  const provider = optionalString(record["provider"]);
  const workspace = optionalString(record["workspace"]);
  if (principal === null || provider === null || workspace === null) {
    return null;
  }
  // SAFETY: `channel` is one of CHANNELS, checked above.
  const typed = channel as DeliveryChannel;
  const address = typed === "email" ? raw.trim().toLowerCase() : raw;
  const valid =
    typed === "email"
      ? isAddrSpec(address)
      : typed === "chat"
        ? isChatAddress(address) &&
          (principal !== undefined || provider !== undefined)
        : isWebhookAddress(address) && principal !== undefined;
  if (!valid) {
    return null;
  }
  return compact<Checked>({
    channel: typed,
    address,
    principal,
    provider,
    workspace,
    trusted: principal === undefined && record["trusted"] === true,
  });
}

function denialReason(decision: Decision): string {
  switch (decision.outcome) {
    case "granted":
      return "granted";
    case "approval-required":
      return "approval-required";
    case "denied":
      return decision.denials[0]?.reason ?? "no-grant";
    default: {
      const never: never = decision;
      return never;
    }
  }
}

const TRANSPORT_CAUSES: ReadonlySet<string> = new Set<DeliveryFailureCause>([
  "invalid-recipient",
  "invalid-message",
  "rate-limited",
  "quota-exceeded",
  "unauthorized",
  "unavailable",
  "suppressed",
  "rejected",
]);

function isTransportCause(value: unknown): value is DeliveryFailureCause {
  return typeof value === "string" && TRANSPORT_CAUSES.has(value);
}

function resultOf(value: unknown): DeliveryResult | Failure {
  const record = ownRecord(value);
  if (record?.["status"] === "sent") {
    const providerId = record["providerId"];
    return typeof providerId === "string" && providerId !== ""
      ? { status: "sent", providerId }
      : { status: "sent" };
  }
  if (record?.["status"] === "failed") {
    const cause = record["cause"];
    const reason = record["reason"];
    return compact<Failure>({
      cause: isTransportCause(cause) ? cause : "rejected",
      retryable: record["retryable"] === true,
      reason: typeof reason === "string" ? reason : undefined,
    });
  }
  return {
    cause: "unavailable",
    retryable: true,
    reason: "transport returned no result",
  };
}

/** Routes checked recipients to channel transports and records a delivery event for each. */
export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  _policy: Policy<TUser, TPrincipal, V>,
  options: DeliveryPermDockOptions,
): DeliveryPermDock<V> {
  const source = options.source ?? "permdock";

  const decideRecipient = async (
    permdock: PermDock<V>,
    checked: Checked,
    permission: Permission,
    row: unknown,
  ): Promise<
    { readonly decision: Decision; readonly principal?: string } | Failure
  > => {
    if (checked.principal !== undefined) {
      return {
        decision: await permdock.decideFor(checked.principal, permission, row),
        principal: checked.principal,
      };
    }
    // SAFETY: an address-only recipient is email or chat; checkRecipient refuses an address-only webhook.
    const kind = checked.channel as "email" | "chat";
    const linked = await loadPrincipalByIdentity(
      options.principals,
      compact({
        kind,
        provider: kind === "chat" ? checked.provider : undefined,
        value: checked.address,
        workspace: kind === "chat" ? checked.workspace : undefined,
      }),
    );
    if (linked !== null) {
      return {
        decision: await permdock.decideFor(linked.id, permission, row),
        principal: linked.id,
      };
    }
    if (!checked.trusted) {
      return {
        cause: "unlinked",
        retryable: false,
        reason: "no principal is linked to the address",
      };
    }
    return {
      decision: permdock.decide(permission, row, {
        trusted: true,
        call: "can",
        adapter: "delivery",
      }),
    };
  };

  const deliverOne = async (
    permdock: PermDock<V>,
    recipient: Recipient,
    permission: Permission,
    row: unknown,
    messages: Partial<DeliveryMessages>,
    id: string,
    base: Pick<DeliveryEvent, "permission" | "tenant" | "approval">,
  ): Promise<DeliveryEvent> => {
    const checked = checkRecipient(recipient);
    const rawChannel = ownRecord(recipient)?.["channel"];
    const channel: DeliveryChannel =
      checked?.channel ??
      (rawChannel === "chat" || rawChannel === "webhook"
        ? rawChannel
        : "email");
    const key = idempotencyKeyFor(
      id,
      channel,
      JSON.stringify([
        checked?.principal ?? null,
        checked?.provider ?? null,
        checked?.workspace ?? null,
        checked?.address ?? null,
      ]),
    );
    const category = channel === "email" ? messages.email?.category : undefined;
    let principal = checked?.principal;
    let trusted = false;
    let provider: DeliveryEvent["provider"];
    const event = (
      operation: "sent" | "failed",
      extra: Partial<
        Pick<DeliveryEvent, "cause" | "retryable" | "reason">
      > = {},
    ): DeliveryEvent =>
      deliveryEvent(
        compact({
          source,
          operation,
          channel,
          delivery: { id, key },
          recipient:
            principal === undefined && !trusted
              ? undefined
              : compact({
                  principal:
                    principal === undefined ? undefined : { id: principal },
                  trusted: trusted ? true : undefined,
                }),
          ...base,
          category,
          provider,
          ...extra,
        }),
      );
    const fail = (failure: Failure): DeliveryEvent =>
      event(
        "failed",
        compact({
          cause: failure.cause,
          retryable: failure.retryable,
          reason: failure.reason,
        }),
      );

    if (checked === null) {
      return fail({
        cause: "invalid-recipient",
        retryable: false,
        reason: "recipient is malformed",
      });
    }
    // SAFETY: each channel key holds the transport of that channel; DeliveryTransports types them so.
    const transport = options.transports[checked.channel] as
      | DeliveryTransport
      | undefined;
    if (transport === undefined) {
      return fail({ cause: "no-transport", retryable: false });
    }
    const message = messages[checked.channel];
    if (message === undefined) {
      return fail({ cause: "no-message", retryable: false });
    }
    let decided: Awaited<ReturnType<typeof decideRecipient>>;
    try {
      decided = await decideRecipient(permdock, checked, permission, row);
    } catch {
      return fail({
        cause: "denied",
        retryable: false,
        reason: "closure-error",
      });
    }
    if (!("decision" in decided)) {
      return fail(decided);
    }
    principal = decided.principal;
    trusted = decided.principal === undefined;
    if (decided.decision.outcome !== "granted") {
      return fail({
        cause: "denied",
        retryable: false,
        reason: denialReason(decided.decision),
      });
    }
    const target: DeliveryTarget = Object.freeze(
      compact<DeliveryTarget>({
        channel: checked.channel,
        address: checked.address,
        principal,
        provider: checked.provider,
        workspace: checked.workspace,
        trusted: trusted ? true : undefined,
        decision: decided.decision satisfies GrantedDecision,
      }),
    );
    let outgoing: unknown = message;
    if (checked.channel === "email") {
      try {
        const built = outgoingEmail(
          // SAFETY: `messages.email` is the message of the email channel.
          message as DeliveryMessages["email"],
          // SAFETY: the target was built for the email channel above.
          target as DeliveryTarget<"email">,
          options.from,
        );
        if (!built.ok) {
          return fail({
            cause: "invalid-message",
            retryable: false,
            reason: built.reason,
          });
        }
        outgoing = built.email;
      } catch {
        return fail({
          cause: "invalid-message",
          retryable: false,
          reason: "unsubscribe threw",
        });
      }
    }
    provider = { name: transport.name };
    let result: DeliveryResult | Failure;
    try {
      result = resultOf(
        await transport.deliver(
          target,
          // SAFETY: `outgoing` is the message for `target.channel`, the transport's channel.
          outgoing as never,
          { idempotencyKey: key, delivery: id },
        ),
      );
    } catch {
      result = {
        cause: "unavailable",
        retryable: true,
        reason: "transport threw",
      };
    }
    if ("status" in result && result.status === "sent") {
      provider = compact({ name: transport.name, id: result.providerId });
      return event("sent");
    }
    return fail(result);
  };

  return Object.freeze({
    async deliver(
      permdock: PermDock<V>,
      target: Permission | Pick<Operation, "name" | "permission">,
      row: unknown,
      recipients: readonly Recipient[],
      messages: Partial<DeliveryMessages>,
      deliverOptions: DeliverOptions = {},
    ): Promise<DeliveryReport> {
      const permission = "permission" in target ? target.permission : target;
      const id = deliverOptions.id ?? `dlv_${globalThis.crypto.randomUUID()}`;
      const base = compact<
        Pick<DeliveryEvent, "permission" | "tenant" | "approval">
      >({
        permission: permission.key,
        tenant: permdock.subject.principal?.tenant,
        approval: deliverOptions.approval,
      });
      const events = await Promise.all(
        recipients.map((recipient) =>
          deliverOne(permdock, recipient, permission, row, messages, id, base),
        ),
      );
      try {
        await options.sink?.write(events);
      } catch {
        // A sink outage never fails a delivery that already went out.
      }
      const sent = events.filter((entry) => entry.operation === "sent").length;
      return freezeDeep({
        id,
        events,
        sent,
        failed: events.length - sent,
      });
    },
  });
}
