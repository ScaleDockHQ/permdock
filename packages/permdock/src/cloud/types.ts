import type { ApprovalStore } from "../approvals/types.ts";
import type { CatalogDocument } from "../catalog/types.ts";
import type { PolicySource } from "../core/hosted.ts";
import type {
  DecisionSink,
  SnapshotSource,
  TokenVerifier,
} from "../core/interfaces.ts";

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

/** What every `permdock/cloud` client needs to reach one environment. */
export type CloudConnectionOptions = CloudEndpointOptions & {
  /** The environment key; defaults to `PERMDOCK_CLOUD_KEY`. */
  readonly key?: string;
  readonly fetch?: typeof fetch;
};

export type CloudOptions = CloudConnectionOptions & {
  readonly flushAt?: number;
  /** Most events the sink holds while the Cloud is unreachable (default 10 000); the oldest are dropped first. */
  readonly capacity?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
  /** The CloudEvents `source` of every event the sink sends, an absolute URI; defaults to the environment URL. */
  readonly source?: string;
  /**
   * Verifies the environment's signed policy document, typically
   * `joseTokenVerifier({ jwks: cloudEndpoints().jwks })`. Without one,
   * `policies.current()` stays `null`: an unverifiable document is never applied.
   */
  readonly verifier?: TokenVerifier;
};

export type CloudCatalog = {
  /**
   * Posts the catalog, its `operations` included, to the environment, and
   * resolves to the fingerprint it pushed. Throws when the Cloud refuses it.
   * The Cloud shows and diffs it; it never decides with it.
   */
  push(catalog: CatalogDocument): Promise<{ readonly fingerprint: string }>;
};

export type CloudClient = CloudEndpoints & {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  readonly snapshots: SnapshotSource;
  readonly policies: PolicySource;
  readonly catalog: CloudCatalog;
};

export type CloudSignerOptions = CloudConnectionOptions & {
  /** `aud` when a `sign` call names none; signing without either throws. */
  readonly audience?: string | readonly string[];
};
