import type { DecisionSink, PolicySource } from "permdock";
import type { ApprovalStore } from "permdock/approvals";
import type { CloudApproverOptions } from "permdock/cloud";

import { memoryApprovalStore } from "permdock/approvals";
import { cloud, cloudApprovalWaiter, cloudEndpoints } from "permdock/cloud";
import { joseTokenSigner, joseTokenVerifier } from "permdock/jwt";
import { memoryReplayStore } from "permdock/ssf";

import type { CloudEnv } from "./env.ts";

/** The dashboard that hosts the environment's approval inbox. */
export const CLOUD_INBOX = "https://app.permdock.com";

export type Backend = {
  readonly store: ApprovalStore;
  readonly sink: DecisionSink | null;
  /** The `com.permdock.approval.*` webhook endpoint; `null` without the Cloud. */
  readonly webhook: ((request: Request) => Promise<Response>) | null;
  readonly inbox: string | null;
  /** The environment's signed hosted grants; `null` without the Cloud. */
  readonly policies: PolicySource | null;
};

function approverOf(env: CloudEnv): CloudApproverOptions | null {
  if (env.approverJwk === null || env.approverIssuer === null) {
    return null;
  }
  // SAFETY: the variable holds a private JWK the environment trusts as an issuer.
  const key = JSON.parse(env.approverJwk) as Record<string, unknown>;
  return {
    signer: joseTokenSigner({
      key,
      alg: "ES256",
      kid: typeof key["kid"] === "string" ? key["kid"] : "approver",
      issuer: env.approverIssuer,
    }),
  };
}

/**
 * `cloud()` when the environment is configured, the in-memory store otherwise.
 * Without an approver key the Cloud refuses `resolve`, so approvals are
 * answered in the inbox instead of `POST /approve`.
 */
export function backend(env: CloudEnv | null): Backend {
  if (env === null) {
    return {
      store: memoryApprovalStore(),
      sink: null,
      webhook: null,
      inbox: null,
      policies: null,
    };
  }
  const approver = approverOf(env);
  const environment =
    env.environment === null ? {} : { environment: env.environment };
  const endpoints = cloudEndpoints({ url: env.url, ...environment });
  const permdockCloud = cloud({
    url: env.url,
    key: env.key,
    ...environment,
    ...(approver === null ? {} : { approver }),
    verifier: joseTokenVerifier({
      ...endpoints,
      algorithms: ["Ed25519", "ES256"],
    }),
  });
  const waiter = cloudApprovalWaiter({
    store: permdockCloud.approvals,
    jwks: permdockCloud.jwks,
    ...(env.webhookSecret === null ? {} : { secret: env.webhookSecret }),
    replay: memoryReplayStore(),
  });
  return {
    store: permdockCloud.approvals,
    sink: permdockCloud.sink,
    webhook: waiter.webhook,
    inbox: CLOUD_INBOX,
    policies: permdockCloud.policies,
  };
}
