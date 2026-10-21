import type { TokenSigner } from "../core/interfaces.ts";
import type {
  CaepCommon,
  CaepReason,
  PushSetOptions,
  SetDelivery,
  SetDeliveryFailureCause,
  SetEvent,
  SetSubject,
  SignSetOptions,
} from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { epochSeconds } from "../core/time.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { readBodyText } from "../server/body-text.ts";
import { CAEP_PREFIX, RISC_PREFIX, VERIFICATION_EVENT } from "./events.ts";
import { SET_CONTENT, SET_TYP } from "./wire.ts";

/** SSF 1.0 delivery method URN for RFC 8935 push. */
export const SSF_PUSH_DELIVERY = "urn:ietf:rfc:8935";
/** SSF 1.0 delivery method URN for RFC 8936 poll. */
export const SSF_POLL_DELIVERY = "urn:ietf:rfc:8936";

/** Milliseconds one push may take. */
const PUSH_TIMEOUT_MS = 30_000;
/** The largest error body `pushSet` reads. */
const MAX_ERROR_BYTES = 16_384;

/**
 * Signs one event as an RFC 8417 Security Event Token (`typ: secevent+jwt`):
 * `sub_id` is the event's subject and `events` holds exactly one entry, as
 * SSF 1.0 requires. `iss` is the signer's own.
 */
export function signSet(
  event: SetEvent,
  signer: TokenSigner,
  options: SignSetOptions,
): Promise<string> {
  return signer.sign(
    compact({
      sub_id: event.subject,
      events: { [event.type]: event.payload },
      txn: options.txn,
    }),
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: SET_TYP,
      audience: options.audience,
      jti: options.jti,
      issuedAt: options.issuedAt,
    }),
  );
}

const ERR_CAUSES: Readonly<Record<string, SetDeliveryFailureCause>> = {
  invalid_request: "invalid-request",
  invalid_key: "invalid-key",
  invalid_issuer: "invalid-issuer",
  invalid_audience: "invalid-audience",
  authentication_failed: "authentication-failed",
  access_denied: "access-denied",
};

async function errorBody(
  response: Response,
): Promise<{ readonly err?: string; readonly description?: string }> {
  const read = await readBodyText(response, MAX_ERROR_BYTES);
  if (!read.ok) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (!isRecord(parsed)) {
      return {};
    }
    return compact<{ readonly err?: string; readonly description?: string }>({
      err: typeof parsed["err"] === "string" ? parsed["err"] : undefined,
      description:
        typeof parsed["description"] === "string"
          ? parsed["description"]
          : undefined,
    });
  } catch {
    return {};
  }
}

/**
 * Pushes one SET to a receiver (RFC 8935). A `2xx` is delivery; a `400`
 * maps the receiver's `err` to a cause; `401` and `403` are
 * `authentication-failed` and `access-denied`; a network failure, a timeout,
 * a `429` or a `5xx` is `unavailable` with `retry: true`. Never throws.
 */
export async function pushSet(
  set: string,
  options: PushSetOptions,
): Promise<SetDelivery> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(options.endpoint, {
      method: "POST",
      headers: compact({
        "content-type": SET_CONTENT,
        accept: "application/json",
        authorization: options.authorization,
      }),
      body: set,
      signal: timeoutSignal(PUSH_TIMEOUT_MS, options.signal),
    });
  } catch {
    return { ok: false, cause: "unavailable", retry: true };
  }
  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  return deliveryFailure(response);
}

/** The `SetDelivery` failure for a non-`2xx` RFC 8935 or RFC 8936 response. */
export async function deliveryFailure(
  response: Response,
): Promise<Extract<SetDelivery, { readonly ok: false }>> {
  const { err, description } = await errorBody(response);
  if (response.status === 429 || response.status >= 500) {
    return compact<Extract<SetDelivery, { readonly ok: false }>>({
      ok: false,
      cause: "unavailable",
      description,
      retry: true,
    });
  }
  const fromStatus: SetDeliveryFailureCause | undefined =
    response.status === 401
      ? "authentication-failed"
      : response.status === 403
        ? "access-denied"
        : undefined;
  const cause =
    fromStatus ??
    (err !== undefined && Object.hasOwn(ERR_CAUSES, err)
      ? ERR_CAUSES[err]
      : undefined) ??
    "invalid-request";
  return compact<Extract<SetDelivery, { readonly ok: false }>>({
    ok: false,
    cause,
    description,
    retry: false,
  });
}

function reason(value: CaepReason | undefined): unknown {
  return typeof value === "string" ? { en: value } : value;
}

function caep(
  name: string,
  input: CaepCommon,
  extra: Readonly<Record<string, unknown>>,
): SetEvent {
  return Object.freeze({
    type: `${CAEP_PREFIX}${name}`,
    subject: input.subject,
    payload: Object.freeze(
      compact<Record<string, unknown>>({
        event_timestamp: input.eventTimestamp ?? epochSeconds(),
        initiating_entity: input.initiatingEntity,
        reason_admin: reason(input.reasonAdmin),
        reason_user: reason(input.reasonUser),
        ...extra,
      }),
    ),
  });
}

export type CaepCredentialChange = CaepCommon & {
  readonly credentialType: string;
  readonly changeType: "create" | "revoke" | "update" | "delete";
  readonly friendlyName?: string;
  readonly x509Issuer?: string;
  readonly x509Serial?: string;
  readonly fido2Aaguid?: string;
};

export type CaepTokenClaimsChange = CaepCommon & {
  readonly claims: Readonly<Record<string, unknown>>;
};

export type CaepAssuranceLevelChange = CaepCommon & {
  readonly namespace: string;
  readonly currentLevel: string;
  readonly previousLevel?: string;
  readonly changeDirection?: "increase" | "decrease";
};

export type CaepDeviceComplianceChange = CaepCommon & {
  readonly previousStatus: "compliant" | "not-compliant";
  readonly currentStatus: "compliant" | "not-compliant";
};

export type CaepEvents = {
  readonly sessionRevoked: (input: CaepCommon) => SetEvent;
  readonly credentialChange: (input: CaepCredentialChange) => SetEvent;
  readonly tokenClaimsChange: (input: CaepTokenClaimsChange) => SetEvent;
  readonly assuranceLevelChange: (input: CaepAssuranceLevelChange) => SetEvent;
  readonly deviceComplianceChange: (
    input: CaepDeviceComplianceChange,
  ) => SetEvent;
};

/** CAEP 1.0 event builders; each returns a `SetEvent` for `signSet`. */
export const caepEvents: CaepEvents = Object.freeze({
  sessionRevoked: (input: CaepCommon): SetEvent =>
    caep("session-revoked", input, {}),
  credentialChange: (input: CaepCredentialChange): SetEvent =>
    caep(
      "credential-change",
      input,
      compact<Record<string, unknown>>({
        credential_type: input.credentialType,
        change_type: input.changeType,
        friendly_name: input.friendlyName,
        x509_issuer: input.x509Issuer,
        x509_serial: input.x509Serial,
        fido2_aaguid: input.fido2Aaguid,
      }),
    ),
  tokenClaimsChange: (input: CaepTokenClaimsChange): SetEvent =>
    caep("token-claims-change", input, { claims: input.claims }),
  assuranceLevelChange: (input: CaepAssuranceLevelChange): SetEvent =>
    caep(
      "assurance-level-change",
      input,
      compact<Record<string, unknown>>({
        namespace: input.namespace,
        current_level: input.currentLevel,
        previous_level: input.previousLevel,
        change_direction: input.changeDirection,
      }),
    ),
  deviceComplianceChange: (input: CaepDeviceComplianceChange): SetEvent =>
    caep("device-compliance-change", input, {
      previous_status: input.previousStatus,
      current_status: input.currentStatus,
    }),
});

export type RiscAccountDisabled = {
  readonly subject: SetSubject;
  readonly reason?: "hijacking" | "bulk-account";
};

export type RiscCredentialCompromise = CaepCommon & {
  readonly credentialType: string;
};

function risc(
  name: string,
  subject: SetSubject,
  payload: Readonly<Record<string, unknown>>,
): SetEvent {
  return Object.freeze({
    type: `${RISC_PREFIX}${name}`,
    subject,
    payload: Object.freeze(payload),
  });
}

export type RiscEvents = {
  readonly accountDisabled: (input: RiscAccountDisabled) => SetEvent;
  readonly accountPurged: (input: { readonly subject: SetSubject }) => SetEvent;
  readonly credentialCompromise: (input: RiscCredentialCompromise) => SetEvent;
};

/** RISC 1.0 event builders for the events PermDock's receiver treats as revoking every session. */
export const riscEvents: RiscEvents = Object.freeze({
  accountDisabled: (input: RiscAccountDisabled): SetEvent =>
    risc(
      "account-disabled",
      input.subject,
      compact<Record<string, unknown>>({ reason: input.reason }),
    ),
  accountPurged: (input: { readonly subject: SetSubject }): SetEvent =>
    risc("account-purged", input.subject, {}),
  credentialCompromise: (input: RiscCredentialCompromise): SetEvent =>
    risc(
      "credential-compromise",
      input.subject,
      compact<Record<string, unknown>>({
        credential_type: input.credentialType,
        event_timestamp: input.eventTimestamp ?? epochSeconds(),
        initiating_entity: input.initiatingEntity,
        reason_admin: reason(input.reasonAdmin),
        reason_user: reason(input.reasonUser),
      }),
    ),
});

/**
 * The SSF 1.0 section 8.1.4 verification event for `stream`, echoing the
 * receiver's `state`. Its subject is the stream, never a principal.
 */
export function streamVerificationEvent(
  stream: string,
  state?: string,
): SetEvent {
  return Object.freeze({
    type: VERIFICATION_EVENT,
    subject: Object.freeze({ format: "opaque", id: stream }),
    payload: Object.freeze(compact<Record<string, unknown>>({ state })),
  });
}
