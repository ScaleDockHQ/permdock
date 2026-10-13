import type { DeliveryChannel, DeliveryTarget } from "./types.ts";

import { ownRecord } from "../core/capability.ts";
import { bytesToBase64Url, sha256 } from "../core/sha256.ts";

/**
 * Whether `value` is a target the router checked for `channel`: a non-empty
 * address and a granted decision. A transport calls it first and refuses
 * anything else, so a hand-built recipient never reaches a provider.
 */
export function isDeliveryTarget<C extends DeliveryChannel>(
  value: unknown,
  channel: C,
): value is DeliveryTarget<C> {
  const record = ownRecord(value);
  const address = record?.["address"];
  return (
    record?.["channel"] === channel &&
    typeof address === "string" &&
    address !== "" &&
    ownRecord(record["decision"])?.["outcome"] === "granted"
  );
}

/**
 * The idempotency key for one recipient of delivery `id`: `pdd_` and the
 * base64url SHA-256 of the delivery id, channel and recipient. It fits the
 * tag and header charsets of every provider, `[A-Za-z0-9_-]`.
 */
export function idempotencyKeyFor(
  id: string,
  channel: DeliveryChannel,
  recipient: string,
): string {
  return `pdd_${bytesToBase64Url(sha256(JSON.stringify([id, channel, recipient])))}`;
}

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const ADDR_SPEC = new RegExp(
  `^${ATOM}(?:\\.${ATOM})*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`,
  "u",
);

/**
 * An RFC 5322 `addr-spec` in dot-atom form with a DNS domain, at most 254
 * characters (RFC 5321 path limit). Quoted local parts, comments and
 * domain literals are refused.
 */
export function isAddrSpec(value: string): boolean {
  return value.length <= 254 && ADDR_SPEC.test(value);
}

/** A chat platform user id: printable, no whitespace, at most 256 characters. */
export function isChatAddress(value: string): boolean {
  return /^[!-~]{1,256}$/u.test(value);
}

/** An absolute https URL with no credentials. */
export function isWebhookAddress(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" && url.username === "" && url.password === ""
  );
}
