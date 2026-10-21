import type { DeliveryEvent, EmailCategory } from "../core/event-types.ts";
import type { DecisionSink } from "../core/interfaces.ts";
import type { ReplayStore } from "../ssf/types.ts";

import { compact } from "../core/compact.ts";
import { deliveryEvent } from "../core/delivery-event.ts";
import { ownRecord } from "../core/paths.ts";
import { statusProblem } from "../core/problem-types.ts";
import { isRfc3339, nowSeconds } from "../core/time.ts";
import { readBodyText } from "../server/body-text.ts";
import { bodyTooLarge } from "../server/body.ts";
import { methodNotAllowed, problemResponse } from "../server/problem.ts";
import { CATEGORY_TAG, DELIVERY_TAG, KEY_TAG } from "./transport.ts";

/** The part of a `Resend` client the webhook calls; a `new Resend(key)` fits. */
export type ResendWebhookClient = {
  readonly webhooks: {
    verify: (input: {
      readonly payload: string;
      readonly headers: {
        readonly id: string;
        readonly timestamp: string;
        readonly signature: string;
      };
      readonly webhookSecret: string;
    }) => unknown;
  };
};

export type ResendWebhookOptions = {
  readonly resend: ResendWebhookClient;
  /** The endpoint's signing secret, `whsec_…`. */
  readonly secret: string;
  readonly sink: DecisionSink;
  /** Claims each message id, so a redelivered message writes no second event. */
  readonly replay: ReplayStore;
  /** The event `source`; defaults to `permdock`. */
  readonly source?: string;
};

/** Resend allows 5 minutes of clock skew either way; a claim outlives both. */
const CLAIM_SECONDS = 600;
const MAX_BODY = 1_000_000;

const CATEGORIES: ReadonlySet<string> = new Set<EmailCategory>([
  "transactional",
  "notification",
  "security",
  "approval",
]);

function header(request: Request, name: string): string | null {
  return (
    request.headers.get(`svix-${name}`) ??
    request.headers.get(`webhook-${name}`)
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function joined(...parts: readonly unknown[]): string | undefined {
  const found = parts.map(text).filter((part) => part !== undefined);
  return found.length === 0 ? undefined : found.join(": ");
}

type Outcome = Pick<
  DeliveryEvent,
  "operation" | "cause" | "retryable" | "reason"
>;

function outcomeOf(
  type: unknown,
  data: Record<string, unknown>,
): Outcome | undefined {
  switch (type) {
    case "email.delivered":
      return { operation: "delivered" };
    case "email.complained":
      return { operation: "complained" };
    case "email.bounced": {
      const bounce = ownRecord(data["bounce"]);
      return compact({
        operation: "bounced",
        reason: joined(bounce?.["type"], bounce?.["message"]),
      });
    }
    case "email.failed":
      return compact({
        operation: "failed",
        cause: "rejected",
        retryable: false,
        reason: text(ownRecord(data["failed"])?.["reason"]),
      });
    case "email.suppressed": {
      const suppressed = ownRecord(data["suppressed"]);
      return compact({
        operation: "failed",
        cause: "suppressed",
        retryable: false,
        reason: joined(suppressed?.["type"], suppressed?.["message"]),
      });
    }
    default:
      return undefined;
  }
}

/**
 * The delivery event a verified Resend payload stands for, or `null` for one
 * that is not about a PermDock delivery: opens and clicks (tracking, not
 * delivery), sends, contact and domain events, and mail without the
 * `permdock_delivery` and `permdock_key` tags.
 */
function eventOf(payload: unknown, source: string): DeliveryEvent | null {
  const record = ownRecord(payload);
  const data = ownRecord(record?.["data"]);
  if (record === undefined || data === undefined) {
    return null;
  }
  const outcome = outcomeOf(record["type"], data);
  const tags = ownRecord(data["tags"]);
  const id = text(tags?.[DELIVERY_TAG]);
  const key = text(tags?.[KEY_TAG]);
  if (outcome === undefined || id === undefined || key === undefined) {
    return null;
  }
  const category = tags?.[CATEGORY_TAG];
  const at = record["created_at"];
  return deliveryEvent(
    compact({
      at: isRfc3339(at) ? at : undefined,
      source,
      channel: "email",
      delivery: { id, key },
      category:
        typeof category === "string" && CATEGORIES.has(category)
          ? category
          : undefined,
      provider: compact({ name: "resend", id: text(data["email_id"]) }),
      ...outcome,
    }),
  );
}

// Not 401: a webhook has no authentication scheme to name in the
// WWW-Authenticate header RFC 9110 section 15.5.2 requires with it.
function unsigned(): Response {
  return problemResponse(
    statusProblem(400, "webhook signature headers are missing"),
  );
}

function unverified(): Response {
  return problemResponse(
    statusProblem(403, "webhook signature did not verify"),
  );
}

async function claim(replay: ReplayStore, key: string): Promise<boolean> {
  const expiresAt = nowSeconds() + CLAIM_SECONDS;
  if (replay.claim !== undefined) {
    return replay.claim(key, expiresAt);
  }
  if (await replay.seen(key)) {
    return false;
  }
  await replay.remember(key, expiresAt);
  return true;
}

/**
 * A fetch handler for Resend webhooks. It verifies the Standard Webhooks
 * signature through `resend.webhooks.verify` (the `svix-*` and `webhook-*`
 * header names both work), claims the message id, and writes one delivery event
 * for `email.delivered`, `email.bounced`, `email.complained`, `email.failed`
 * and `email.suppressed`. A bad signature is a `401`; a sink failure releases
 * the claim and answers `503`, so Resend retries.
 */
export function resendWebhook(
  options: ResendWebhookOptions,
): (request: Request) => Promise<Response> {
  const source = options.source ?? "permdock";
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const id = header(request, "id");
    const timestamp = header(request, "timestamp");
    const signature = header(request, "signature");
    if (id === null || timestamp === null || signature === null) {
      return unsigned();
    }
    const read = await readBodyText(request, MAX_BODY);
    if (!read.ok) {
      return read.cause === "too-large"
        ? bodyTooLarge(MAX_BODY)
        : problemResponse(statusProblem(400, "webhook body was unreadable"));
    }
    const body = read.text;
    let payload: unknown;
    try {
      payload = options.resend.webhooks.verify({
        payload: body,
        headers: { id, timestamp, signature },
        webhookSecret: options.secret,
      });
    } catch {
      return unverified();
    }
    const replayKey = `resend:${id}`;
    if (!(await claim(options.replay, replayKey))) {
      return new Response(null, { status: 200 });
    }
    const event = eventOf(payload, source);
    if (event !== null) {
      try {
        await options.sink.write([event]);
      } catch {
        await options.replay.release?.(replayKey);
        return problemResponse(
          statusProblem(503, "the event sink is unavailable"),
        );
      }
    }
    return new Response(null, { status: 200 });
  };
}
