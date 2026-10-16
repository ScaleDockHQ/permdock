import type { ApprovalStore } from "../approvals/types.ts";
import type { TokenFailureCause, TokenVerifier } from "../core/interfaces.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { DiscoveryInput, JwtJwks } from "../jwt/types.ts";

/** Every CAEP 1.0 event type, by the last segment of its URI. */
export type CaepEventName =
  | "session-revoked"
  | "credential-change"
  | "assurance-level-change"
  | "token-claims-change"
  | "device-compliance-change"
  | "session-established"
  | "session-presented"
  | "risk-level-change";

/** The RISC 1.0 event types PermDock treats as a revocation of every session. */
export type RiscEventName =
  | "account-disabled"
  | "account-purged"
  | "credential-compromise";

export type SsfEventName = CaepEventName | RiscEventName;

/** An SSF 1.0 stream `verification` event: the `state` the receiver asked the transmitter to echo. */
export type SsfVerification = {
  readonly state?: string;
  readonly jti: string;
  readonly issuer?: string;
};

export type SetSubject = {
  readonly format: string;
  readonly [key: string]: unknown;
};

export type SsfSubject = {
  readonly id: string;
  readonly session?: string;
  readonly issuer?: string;
};

export type SsfSubjectResolver = (
  setSubject: SetSubject,
  meta?: { readonly session?: string; readonly issuer?: string },
) =>
  | string
  | SsfSubject
  | null
  | undefined
  | Promise<string | SsfSubject | null | undefined>;

export type SsfEventInput = {
  readonly subject: SsfSubject;
  readonly event: Readonly<Record<string, unknown>>;
  readonly event_timestamp?: number;
  readonly jti: string;
  readonly type: string;
};

export type SsfEventHandler = (input: SsfEventInput) => void | Promise<void>;

export type SsfOnEvent = {
  readonly [K in SsfEventName]?: SsfEventHandler;
} & {
  readonly "*"?: SsfEventHandler;
  /** SSF 1.0 section 8.1.4.1 stream verification; it names a stream, never a subject. */
  readonly verification?: (input: SsfVerification) => void | Promise<void>;
};

/**
 * Keys are opaque strings namespaced by issuer. A store that implements both
 * `claim` and `release` makes concurrent deliveries of one SET dispatch once;
 * one with only `seen` and `remember` is checked and recorded non-atomically.
 */
export type ReplayStore = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  seen(key: string): boolean | Promise<boolean>;
  remember(key: string, expiresAt?: number): void | Promise<void>;
  /** Records `key` and returns `true` only if it was not already recorded. */
  claim?(key: string, expiresAt?: number): boolean | Promise<boolean>;
  /** Forgets a claimed `key` so a failed delivery can be retried. */
  release?(key: string): void | Promise<void>;
};

export type SsfAuditEvent = {
  readonly type: string;
  readonly subject?: SsfSubject;
  readonly transmitter?: string;
  readonly jti?: string;
  readonly replayed?: true;
  readonly cancelled?: number;
  readonly unknown?: "event" | "subject";
  /** The `state` of a stream `verification` event. */
  readonly state?: string;
  readonly err?: string;
  readonly cause?: TokenFailureCause;
};

export type SsfEventListener = (event: SsfAuditEvent) => void;

export type PollOptions = {
  readonly endpoint: string;
  readonly every?: number | string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

export type PollHandle = {
  readonly stop: () => void;
};

export type PollResult = {
  readonly acked: readonly string[];
};

export type SsfPermDockOptions = {
  readonly issuer?: string;
  readonly audience: string | readonly string[];
  readonly jwks?: JwtJwks | string;
  readonly discovery?: DiscoveryInput;
  readonly verifier?: TokenVerifier;
  readonly subject: SsfSubjectResolver;
  readonly onEvent?: SsfOnEvent;
  readonly replay?: ReplayStore;
  readonly approvals?: ApprovalStore;
  /**
   * Publishes `session-revoked` for a revoked session and `changed` for
   * credential, assurance and claims changes, so open connections end or
   * revalidate.
   */
  readonly revocations?: RevocationFeed;
  readonly clockTolerance?: number;
  /**
   * Seconds a SET without `exp` is accepted after its `iat`; default one
   * day. The replay record is kept at least that long, so a replayed SET
   * is refused for as long as its signature would verify.
   */
  readonly maxTokenAge?: number;
};

export type SsfReceiver = {
  push(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  poll(options: PollOptions): Promise<PollResult> | PollHandle;
  on(event: "event", handler: SsfEventListener): () => void;
};

export type SsfPermDock = {
  readonly receiver: SsfReceiver;
};

/** One event of a SET: the event-type URI, the RFC 9493 subject and the event's own claims. */
export type SetEvent = {
  readonly type: string;
  readonly subject: SetSubject;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** `initiating_entity` (CAEP 1.0 section 2). */
export type CaepInitiatingEntity = "admin" | "user" | "policy" | "system";

/** A reason as text, or a map of language tag to text (CAEP 1.0 section 2). */
export type CaepReason = string | Readonly<Record<string, string>>;

/** The CAEP 1.0 common claims every event builder accepts. */
export type CaepCommon = {
  readonly subject: SetSubject;
  /** NumericDate seconds the event happened at; the signing time when absent. */
  readonly eventTimestamp?: number;
  readonly initiatingEntity?: CaepInitiatingEntity;
  readonly reasonAdmin?: CaepReason;
  readonly reasonUser?: CaepReason;
};

export type SignSetOptions = {
  /** `aud`: the receiver the stream delivers to. */
  readonly audience: string | readonly string[];
  /** `jti`; a fresh UUID when absent. */
  readonly jti?: string;
  /** `txn` (RFC 8417 section 2.2): ties SETs from one transaction together. */
  readonly txn?: string;
  /** `iat`, NumericDate seconds; the signer's clock when absent. */
  readonly issuedAt?: number;
};

/** Why `pushSet` did not deliver: the RFC 8935 `err` code in kebab case, or a transport failure. */
export type SetDeliveryFailureCause =
  | "invalid-request"
  | "invalid-key"
  | "invalid-issuer"
  | "invalid-audience"
  | "authentication-failed"
  | "access-denied"
  | "unavailable";

export type SetDelivery =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly cause: SetDeliveryFailureCause;
      readonly description?: string;
      /** `true` when the same SET may be pushed again: a network failure, a timeout or a `5xx`. */
      readonly retry: boolean;
    };

export type PushSetOptions = {
  /** The receiver's RFC 8935 push endpoint, the stream's `delivery.endpoint_url`. */
  readonly endpoint: string;
  /** The `Authorization` header value, the stream's `delivery.authorization_header`. */
  readonly authorization?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

/** A receiver's report that one SET failed (RFC 8936 section 2.4 `setErrs`). */
export type SetError = {
  readonly err: string;
  readonly description: string;
};

/**
 * The SETs a transmitter holds for RFC 8936 poll delivery, per stream. A SET
 * stays pending until the receiver acknowledges it or reports it failed.
 */
export type SetQueue = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  enqueue(stream: string, jti: string, set: string): void | Promise<void>;
  /** Up to `max` pending SETs, oldest first. */
  pending(
    stream: string,
    max: number,
  ):
    | readonly { readonly jti: string; readonly set: string }[]
    | Promise<readonly { readonly jti: string; readonly set: string }[]>;
  ack(stream: string, jti: string): void | Promise<void>;
  fail(stream: string, jti: string, error: SetError): void | Promise<void>;
};

export type SetPollHandlerOptions = {
  readonly queue: SetQueue;
  /** The stream id the request's credentials may poll, or `null` to refuse it with `401`. */
  readonly authorize: (
    request: Request,
  ) => string | null | Promise<string | null>;
  /** The largest `maxEvents` honoured; default 100. */
  readonly maxEvents?: number;
};

/** SSF 1.0 section 7.1: the document at `/.well-known/ssf-configuration`. */
export type SsfTransmitterConfiguration = {
  readonly spec_version?: string;
  readonly issuer: string;
  readonly jwks_uri?: string;
  readonly delivery_methods_supported?: readonly string[];
  readonly configuration_endpoint?: string;
  readonly status_endpoint?: string;
  readonly add_subject_endpoint?: string;
  readonly remove_subject_endpoint?: string;
  readonly verification_endpoint?: string;
  readonly critical_subject_members?: readonly string[];
  readonly authorization_schemes?: readonly { readonly spec_urn: string }[];
  readonly default_subjects?: "ALL" | "NONE";
};

/** SSF 1.0 section 8.1.1: one stream as the configuration endpoint returns it. */
export type SsfStreamConfiguration = {
  readonly stream_id: string;
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly events_supported?: readonly string[];
  readonly events_requested?: readonly string[];
  readonly events_delivered?: readonly string[];
  readonly delivery: {
    /** `urn:ietf:rfc:8935` (push) or `urn:ietf:rfc:8936` (poll). */
    readonly method: string;
    readonly endpoint_url?: string;
    readonly authorization_header?: string;
  };
  readonly min_verification_interval?: number;
  readonly inactivity_timeout?: number;
  readonly description?: string;
};

/** SSF 1.0 section 8.1.2: a stream's status. */
export type SsfStreamStatus = {
  readonly stream_id: string;
  readonly status: "enabled" | "paused" | "disabled";
  readonly reason?: string;
};
