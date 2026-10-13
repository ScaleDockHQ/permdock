import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
  TransportItem,
  TransportOptions,
} from "../delivery/index.ts";

import { compact } from "../core/compact.ts";
import { bytesToBase64Url, sha256 } from "../core/sha256.ts";
import { isDeliveryTarget } from "../delivery/index.ts";

/** One email as `resend.emails.send` and `resend.batch.send` take it. */
export type ResendEmailPayload = {
  readonly from: string;
  readonly to: string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
  readonly tags?: { readonly name: string; readonly value: string }[];
};

export type ResendError = {
  readonly name: string;
  readonly message: string;
  readonly statusCode: number | null;
};

export type ResendResult<T> =
  | { readonly data: T; readonly error: null }
  | { readonly data: null; readonly error: ResendError };

/** The part of a `Resend` client the transport calls; a `new Resend(key)` fits. */
export type ResendClient = {
  readonly emails: {
    send(
      payload: ResendEmailPayload,
      options?: { readonly idempotencyKey?: string },
    ): Promise<ResendResult<{ readonly id: string }>>;
  };
  readonly batch?: {
    send(
      payloads: ResendEmailPayload[],
      options?: { readonly idempotencyKey?: string },
    ): Promise<
      ResendResult<{ readonly data: readonly { readonly id: string }[] }>
    >;
  };
};

export type ResendTransportOptions = {
  /** The `from` of an email whose message and router set none. */
  readonly from?: string;
  /** The `replyTo` of an email whose message sets none. */
  readonly replyTo?: string;
  /** Tags added to every email; names and values are ASCII letters, digits, `_` and `-`. */
  readonly tags?: Readonly<Record<string, string>>;
};

/** Resend's tag charset, at most 256 characters. */
const TAG = /^[A-Za-z0-9_-]{1,256}$/u;

export const DELIVERY_TAG = "permdock_delivery";
export const KEY_TAG = "permdock_key";
export const CATEGORY_TAG = "permdock_category";

const RESERVED_TAGS: ReadonlySet<string> = new Set([
  DELIVERY_TAG,
  KEY_TAG,
  CATEGORY_TAG,
]);

const RETRYABLE: Readonly<
  Record<string, "rate-limited" | "quota-exceeded" | "unavailable">
> = {
  rate_limit_exceeded: "rate-limited",
  daily_quota_exceeded: "quota-exceeded",
  monthly_quota_exceeded: "quota-exceeded",
  concurrent_idempotent_requests: "unavailable",
  internal_server_error: "unavailable",
  application_error: "unavailable",
};

const FINAL: Readonly<
  Record<string, "unauthorized" | "invalid-message" | "rejected">
> = {
  invalid_api_key: "unauthorized",
  missing_api_key: "unauthorized",
  restricted_api_key: "unauthorized",
  invalid_access: "unauthorized",
  invalid_from_address: "invalid-message",
  invalid_attachment: "invalid-message",
  validation_error: "rejected",
};

/**
 * The failure a Resend error name means. Rate limits, quotas and server
 * errors are retryable with the same idempotency key; a key, sender or
 * validation error is final. An unknown name is retryable only for a 5xx or
 * a missing status.
 */
export function resendFailure(error: ResendError): DeliveryResult {
  const name = error.name;
  const retryable = Object.hasOwn(RETRYABLE, name)
    ? RETRYABLE[name]
    : undefined;
  if (retryable !== undefined) {
    return {
      status: "failed",
      cause: retryable,
      retryable: true,
      reason: name,
    };
  }
  const final = Object.hasOwn(FINAL, name) ? FINAL[name] : undefined;
  if (final !== undefined) {
    return { status: "failed", cause: final, retryable: false, reason: name };
  }
  const status = error.statusCode;
  return status === null || status >= 500
    ? { status: "failed", cause: "unavailable", retryable: true, reason: name }
    : { status: "failed", cause: "rejected", retryable: false, reason: name };
}

const UNAVAILABLE: DeliveryResult = Object.freeze({
  status: "failed",
  cause: "unavailable",
  retryable: true,
  reason: "request failed",
});

function checkTags(
  tags: Readonly<Record<string, string>>,
): { readonly name: string; readonly value: string }[] {
  return Object.entries(tags).map(([name, value]) => {
    if (!TAG.test(name) || !TAG.test(value) || RESERVED_TAGS.has(name)) {
      throw new TypeError(
        `PermDock: Resend tag ${JSON.stringify(name)} is reserved or outside [A-Za-z0-9_-]`,
      );
    }
    return { name, value };
  });
}

const REFUSED: DeliveryResult = Object.freeze({
  status: "failed",
  cause: "invalid-recipient",
  retryable: false,
});

async function sendBatch(
  resend: ResendClient,
  items: readonly TransportItem<"email">[],
  payloadOf: (
    target: DeliveryTarget<"email">,
    email: OutgoingEmail,
    options: TransportOptions,
  ) => ResendEmailPayload,
): Promise<readonly DeliveryResult[]> {
  const results: DeliveryResult[] = items.map(() => REFUSED);
  const valid = items.flatMap((item, index) =>
    isDeliveryTarget(item.target, "email") ? [index] : [],
  );
  if (valid.length === 0 || resend.batch === undefined) {
    return results;
  }
  const key = `pdb_${bytesToBase64Url(
    sha256(
      JSON.stringify(
        valid.map((index) => items[index]?.options.idempotencyKey),
      ),
    ),
  )}`;
  let answer:
    | Awaited<ReturnType<NonNullable<ResendClient["batch"]>["send"]>>
    | undefined;
  try {
    answer = await resend.batch.send(
      valid.flatMap((index) => {
        const item = items[index];
        return item === undefined
          ? []
          : [payloadOf(item.target, item.message, item.options)];
      }),
      { idempotencyKey: key },
    );
  } catch {
    answer = undefined;
  }
  for (const [offset, index] of valid.entries()) {
    if (answer === undefined) {
      results[index] = UNAVAILABLE;
      continue;
    }
    if (answer.error !== null) {
      results[index] = resendFailure(answer.error);
      continue;
    }
    const id = answer.data.data[offset]?.id;
    results[index] =
      id === undefined ? UNAVAILABLE : { status: "sent", providerId: id };
  }
  return results;
}

/**
 * Sends the email channel of `permdock/delivery` through Resend. The
 * idempotency key is Resend's `idempotencyKey`. The delivery id, key and
 * category travel as tags, so `resendWebhook` can join provider events to
 * the delivery. Two or more recipients go out through `batch.send`, up to
 * 100 per call. Throws a `TypeError` for a tag outside Resend's charset.
 */
export function resendTransport(
  resend: ResendClient,
  options: ResendTransportOptions = {},
): EmailTransport {
  const tags = checkTags(options.tags ?? {});

  const payloadOf = (
    target: DeliveryTarget<"email">,
    email: OutgoingEmail,
    transportOptions: TransportOptions,
  ): ResendEmailPayload =>
    compact<ResendEmailPayload>({
      from: email.from,
      to: [target.address],
      replyTo: email.replyTo ?? options.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { ...email.headers },
      tags: [
        ...tags,
        ...(TAG.test(transportOptions.delivery)
          ? [{ name: DELIVERY_TAG, value: transportOptions.delivery }]
          : []),
        { name: KEY_TAG, value: transportOptions.idempotencyKey },
        { name: CATEGORY_TAG, value: email.category },
      ],
    });

  return Object.freeze(
    compact<EmailTransport>({
      channel: "email",
      name: "resend",
      from: options.from,
      batchSize: 100,
      async deliver(
        target: DeliveryTarget<"email">,
        email: OutgoingEmail,
        transportOptions: TransportOptions,
      ): Promise<DeliveryResult> {
        if (!isDeliveryTarget(target, "email")) {
          return REFUSED;
        }
        try {
          const { data, error } = await resend.emails.send(
            payloadOf(target, email, transportOptions),
            { idempotencyKey: transportOptions.idempotencyKey },
          );
          if (error !== null) {
            return resendFailure(error);
          }
          return { status: "sent", providerId: data.id };
        } catch {
          return UNAVAILABLE;
        }
      },
      deliverBatch:
        resend.batch === undefined
          ? undefined
          : (
              items: readonly TransportItem<"email">[],
            ): Promise<readonly DeliveryResult[]> =>
              sendBatch(resend, items, payloadOf),
    }),
  );
}
