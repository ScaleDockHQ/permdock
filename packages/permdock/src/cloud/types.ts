import type { ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  SnapshotSource,
  TokenVerifier,
} from '../core/interfaces.ts';

export type CloudOptions = {
  readonly url?: string;
  readonly key?: string;
  readonly environment?: string;
  readonly fetch?: typeof fetch;
  readonly flushAt?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
  /**
   * Verifies the environment's signed policy document, typically
   * `joseTokenVerifier({ jwks: cloud.jwks })`. Without one, `policies.current()`
   * stays `null`: an unverifiable document is never applied.
   */
  readonly verifier?: TokenVerifier;
  /** The `aud` the policy document must carry; your application's identifier. */
  readonly audience?: string | readonly string[];
};

export type CloudClient = {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  readonly snapshots: SnapshotSource;
  readonly policies: PolicySource;
  /** The environment's JWK Set URL, for `joseTokenVerifier({ jwks })`. */
  readonly jwks: string;
};
