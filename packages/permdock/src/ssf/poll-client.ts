import type { SetDelivery, SetError } from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { readBodyText } from "../server/body-text.ts";
import { deliveryFailure } from "./transmitter.ts";

/** Milliseconds one poll request may take. */
const POLL_TIMEOUT_MS = 30_000;
/** The largest poll response read. */
const MAX_SETS_BYTES = 4_194_304;

export type PollSetsOptions = {
  /** The transmitter's RFC 8936 poll endpoint, the stream's `delivery.endpoint_url`. */
  readonly endpoint: string;
  /** The `Authorization` header value. */
  readonly authorization?: string;
  /** `jti` values of SETs the receiver accepted. */
  readonly acks?: readonly string[];
  /** SETs the receiver refused, by `jti`. */
  readonly setErrs?: Readonly<Record<string, SetError>>;
  /** At most this many SETs in the response; default 100. `0` only acknowledges. */
  readonly maxEvents?: number;
  /** Default `true`: answer at once rather than wait for a SET. */
  readonly returnImmediately?: boolean;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

/** One SET from a poll response: its `jti` and the compact JWS, not yet verified. */
export type PolledSet = {
  readonly jti: string;
  readonly set: string;
};

export type PollSetsResult =
  | {
      readonly ok: true;
      readonly sets: readonly PolledSet[];
      readonly moreAvailable: boolean;
    }
  | Extract<SetDelivery, { readonly ok: false }>;

/**
 * One RFC 8936 poll request: sends `acks` and `setErrs` and answers the SETs
 * the transmitter returns, unverified. A failure maps as `pushSet`'s does; a
 * `2xx` body without a `sets` object is `invalid-request`. Never throws.
 */
export async function pollSets(
  options: PollSetsOptions,
): Promise<PollSetsResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const acks = options.acks ?? [];
  const setErrs = options.setErrs ?? {};
  let response: Response;
  try {
    response = await fetchFn(options.endpoint, {
      method: "POST",
      headers: compact({
        "content-type": "application/json",
        accept: "application/json",
        authorization: options.authorization,
      }),
      body: JSON.stringify(
        compact({
          acks: acks.length > 0 ? acks : undefined,
          setErrs: Object.keys(setErrs).length > 0 ? setErrs : undefined,
          maxEvents: options.maxEvents ?? 100,
          returnImmediately: options.returnImmediately ?? true,
        }),
      ),
      signal: timeoutSignal(POLL_TIMEOUT_MS, options.signal),
    });
  } catch {
    return { ok: false, cause: "unavailable", retry: true };
  }
  if (!response.ok) {
    return deliveryFailure(response);
  }
  const read = await readBodyText(response, MAX_SETS_BYTES);
  let parsed: unknown;
  try {
    parsed = read.ok ? JSON.parse(read.text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["sets"])) {
    return {
      ok: false,
      cause: "invalid-request",
      description: "poll response has no sets object",
      retry: false,
    };
  }
  return {
    ok: true,
    sets: Object.entries(parsed["sets"]).flatMap(([jti, set]) =>
      typeof set === "string" ? [{ jti, set }] : [],
    ),
    moreAvailable: parsed["moreAvailable"] === true,
  };
}
