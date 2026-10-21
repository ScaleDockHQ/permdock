import type {
  DeliveryTarget,
  EmailMessage,
  EmailUnsubscribe,
  OutgoingEmail,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { isAddrSpec } from "./target.ts";

/** RFC 5322 `field-name`: printable US-ASCII except the colon. */
const FIELD_NAME = /^[!-9;-~]{1,76}$/u;
const NAME_ADDR = /^([^<>]*)<([^<>]+)>$/u;

/** Fields the router owns, compared lower-cased. */
const ROUTER_FIELDS: ReadonlySet<string> = new Set([
  "auto-submitted",
  "list-unsubscribe",
  "list-unsubscribe-post",
]);

/**
 * Fields that would add recipients or rewrite the envelope past the recipient
 * check.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "from",
  "sender",
  "reply-to",
  "subject",
  "return-path",
  "resent-to",
  "resent-cc",
  "resent-bcc",
]);

export type OutgoingEmailResult =
  | { readonly ok: true; readonly email: OutgoingEmail }
  | { readonly ok: false; readonly reason: string };

/** An unfolded field body: no CR, LF or other control character but tab. */
function isFieldBody(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function fail(reason: string): OutgoingEmailResult {
  return { ok: false, reason };
}

function isMailbox(value: string): boolean {
  const named = NAME_ADDR.exec(value.trim());
  return named === null
    ? isAddrSpec(value)
    : isAddrSpec(named[2]?.trim() ?? "");
}

function unsubscribeFor(
  message: EmailMessage,
  target: DeliveryTarget<"email">,
): EmailUnsubscribe | undefined {
  const unsubscribe = message.unsubscribe;
  return typeof unsubscribe === "function" ? unsubscribe(target) : unsubscribe;
}

function unsubscribeHeaders(
  unsubscribe: EmailUnsubscribe | undefined,
): Record<string, string> | string {
  let url: URL;
  try {
    url = new URL(unsubscribe?.url ?? "");
  } catch {
    return "a notification needs an https unsubscribe url (RFC 8058)";
  }
  if (url.protocol !== "https:") {
    return "a notification needs an https unsubscribe url (RFC 8058)";
  }
  const mailto = unsubscribe?.mailto;
  if (mailto !== undefined && !isAddrSpec(mailto)) {
    return "unsubscribe mailto is not an addr-spec";
  }
  return {
    "List-Unsubscribe":
      mailto === undefined
        ? `<${url.href}>`
        : `<${url.href}>, <mailto:${mailto}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * The email a transport sends to `target`: `from` resolved, the caller's
 * headers checked, `Auto-Submitted: auto-generated` (RFC 3834) on every
 * message, and the RFC 2369 / RFC 8058 unsubscribe pair on `notification` only.
 * A message that cannot be sent as given returns the reason.
 */
export function outgoingEmail(
  message: EmailMessage,
  target: DeliveryTarget<"email">,
  defaultFrom: string | undefined,
): OutgoingEmailResult {
  const from = message.from ?? defaultFrom;
  if (from === undefined || !isFieldBody(from) || !isMailbox(from)) {
    return fail("from is not a mailbox");
  }
  if (message.replyTo !== undefined && !isAddrSpec(message.replyTo)) {
    return fail("replyTo is not an addr-spec");
  }
  if (
    typeof message.subject !== "string" ||
    message.subject.trim() === "" ||
    !isFieldBody(message.subject)
  ) {
    return fail("subject is empty or has a line break");
  }
  if (typeof message.text !== "string" || message.text === "") {
    return fail("text is empty");
  }
  const headers: Record<string, string> = {
    "Auto-Submitted": "auto-generated",
  };
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      !FIELD_NAME.test(name) ||
      typeof value !== "string" ||
      !isFieldBody(value)
    ) {
      return fail(`header ${JSON.stringify(name)} is not a single-line field`);
    }
    if (ENVELOPE_FIELDS.has(lower)) {
      return fail(`header ${name} is set through the message, not headers`);
    }
    if (!ROUTER_FIELDS.has(lower)) {
      headers[name] = value;
    }
  }
  if (message.category === "notification") {
    const pair = unsubscribeHeaders(unsubscribeFor(message, target));
    if (typeof pair === "string") {
      return fail(pair);
    }
    Object.assign(headers, pair);
  }
  return {
    ok: true,
    email: Object.freeze(
      compact<OutgoingEmail>({
        from,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        category: message.category,
        headers: Object.freeze(headers),
      }),
    ),
  };
}
