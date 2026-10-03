import type { ApprovalStore } from '../approvals/types.ts';
import type { TokenFailureCause, TokenVerifier } from '../core/interfaces.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { DiscoveryInput, JwtJwks } from '../jwt/types.ts';

export type CaepEventName =
  | 'session-revoked'
  | 'credential-change'
  | 'assurance-level-change'
  | 'token-claims-change'
  | 'device-compliance-change';

export type SetSubject = {
  readonly format: string;
  readonly [key: string]: unknown;
};

export type SsfSubject = {
  readonly id: string;
  readonly session?: string;
  readonly issuer?: string;
};

export type SsfSubjectMapper = (
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
  readonly [K in CaepEventName]?: SsfEventHandler;
} & {
  readonly '*'?: SsfEventHandler;
};

/**
 * Keys are opaque strings namespaced by issuer. A store that implements both
 * `claim` and `release` makes concurrent deliveries of one SET dispatch once;
 * one with only `seen` and `remember` is checked and recorded non-atomically.
 */
export type ReplayStore = {
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
  readonly unknown?: 'event' | 'subject';
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
  readonly subject: SsfSubjectMapper;
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
};

export type SsfReceiver = {
  push(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  poll(options: PollOptions): Promise<PollResult> | PollHandle;
  on(event: 'event', handler: SsfEventListener): () => void;
};

export type SsfPermDock = {
  readonly receiver: SsfReceiver;
};
