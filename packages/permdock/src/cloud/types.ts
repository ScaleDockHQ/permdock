import type { ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  SnapshotSource,
  TokenVerifier,
} from '../core/interfaces.ts';

export type CloudEndpointOptions = {
  readonly url?: string;
  readonly environment?: string;
};

export type CloudEndpoints = {
  /** The environment URL, `<url>/v1/environments/<env>`: `iss` and `aud` of the policy document. */
  readonly issuer: string;
  /** The environment's JWK Set URL, for `joseTokenVerifier({ jwks })`. */
  readonly jwks: string;
};

export type CloudOptions = CloudEndpointOptions & {
  readonly key?: string;
  readonly fetch?: typeof fetch;
  readonly flushAt?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
  /**
   * Verifies the environment's signed policy document, typically
   * `joseTokenVerifier({ jwks: cloudEndpoints().jwks })`. Without one,
   * `policies.current()` stays `null`: an unverifiable document is never applied.
   */
  readonly verifier?: TokenVerifier;
};

export type CloudClient = CloudEndpoints & {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  readonly snapshots: SnapshotSource;
  readonly policies: PolicySource;
};
