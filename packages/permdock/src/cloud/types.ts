import type { ApprovalRequest, ApprovalStore } from "../approvals/types.ts";
import type { CatalogDocument } from "../catalog/types.ts";
import type { PolicySource } from "../core/hosted.ts";
import type {
  DecisionSink,
  SnapshotSource,
  TokenSigner,
  TokenVerifier,
} from "../core/interfaces.ts";
import type { CatalogFinding } from "../core/sink.ts";
import type { Subject } from "../core/subject.ts";

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

/** Who signs the `PermDock-Approver` token `approvals.resolve` sends. */
export type CloudApproverOptions = {
  /**
   * Signs the token with a key the environment trusts as an issuer, such as
   * `joseTokenSigner` over your own key. Never `cloudSigner`: a client key
   * that could mint approver tokens could forge any approver.
   */
  readonly signer: TokenSigner;
  /** `aud` of the token; defaults to `<issuer>/approvals`, the environment URL plus `/approvals`. */
  readonly audience?: string | readonly string[];
  /**
   * The `holder(permission)` approvers of `request` that `approver` holds,
   * typically `approverPermissions(request, permdockFor(approver))`. Signed
   * into the token as `permissions`; without it the verdict's own
   * `permissions` are signed. A throw signs none.
   */
  readonly permissions?: (
    request: ApprovalRequest,
    approver: Subject,
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * The relation approvers of `request` that `approver` holds, typically
   * `approverRelations(request, approver, { relations, permissions })`.
   * Signed into the token as `relations`; without it the verdict's own
   * `relations` are signed. A throw signs none.
   */
  readonly relations?: (
    request: ApprovalRequest,
    approver: Subject,
  ) => readonly string[] | Promise<readonly string[]>;
};

export type CloudOptions = CloudConnectionOptions & {
  /**
   * Proves the approver on `approvals.resolve`. Without it, every resolve but
   * a `system` rejection throws `approver-unauthenticated` and sends nothing.
   */
  readonly approver?: CloudApproverOptions;
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

/**
 * What `POST /catalog` answers: `201` with the new version and the drift
 * findings against the previous one, or `200` with `unchanged: true` when
 * the fingerprint is already published.
 */
export type CloudCatalogPush =
  | {
      readonly version: number;
      readonly fingerprint: string;
      readonly findings: readonly CatalogFinding[];
    }
  | {
      readonly version: number;
      readonly fingerprint: string;
      readonly unchanged: true;
    };

export type CloudCatalog = {
  /**
   * Posts the catalog, its `operations` included, to the environment.
   * Throws when the Cloud refuses it or answers another shape. The Cloud
   * shows and diffs it; it never decides with it.
   */
  push(catalog: CatalogDocument): Promise<CloudCatalogPush>;
};

export type CloudClient = CloudEndpoints & {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  /**
   * A `SnapshotSource` for the subject `token` proves: an `at+jwt` the
   * environment issued, or one a trusted issuer registered for `subject`
   * signed. Sent as `PermDock-Subject`; the Cloud never takes a subject from
   * anything else.
   */
  snapshotsFor(token: string): SnapshotSource;
  readonly policies: PolicySource;
  readonly catalog: CloudCatalog;
};

export type CloudSignerOptions = CloudConnectionOptions & {
  /** `aud` when a `sign` call names none; signing without either throws. */
  readonly audience?: string | readonly string[];
};
