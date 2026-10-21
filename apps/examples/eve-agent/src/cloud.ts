import type { DecisionSink, PolicySource } from "permdock";
import type { ApprovalStore } from "permdock/approvals";
import type {
  CloudApprovalWaiter,
  CloudApproverOptions,
  CloudClient,
  CloudEndpoints,
} from "permdock/cloud";

import { memoryApprovalStore } from "permdock/approvals";
import { cloud, cloudApprovalWaiter } from "permdock/cloud";
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
 * The webhook connector's endpoint. Without PERMDOCK_CLOUD_ENV the JWK Set URL
 * for `v1a` signatures is known only once the key's environment resolves.
 */
function lazyWebhook(
  permdockCloud: CloudClient,
  secret: string | null,
): (request: Request) => Promise<Response> {
  const replay = memoryReplayStore();
  const waiterFor = ({ jwks }: CloudEndpoints): CloudApprovalWaiter =>
    cloudApprovalWaiter({
      store: permdockCloud.approvals,
      jwks,
      ...(secret === null ? {} : { secret }),
      replay,
    });
  let waiter: Promise<CloudApprovalWaiter> | undefined;
  return async (request) => {
    waiter ??= permdockCloud.endpoints().then(waiterFor);
    let ready: CloudApprovalWaiter;
    try {
      ready = await waiter;
    } catch {
      waiter = undefined;
      return Response.json(
        {
          type: "about:blank",
          title: "Service Unavailable",
          status: 503,
          detail: "PermDock Cloud did not name the key's environment",
        },
        {
          status: 503,
          headers: { "content-type": "application/problem+json" },
        },
      );
    }
    return ready.webhook(request);
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
  const permdockCloud = cloud({
    url: env.url,
    key: env.key,
    ...environment,
    ...(approver === null ? {} : { approver }),
    verifier: (endpoints) =>
      joseTokenVerifier({ ...endpoints, algorithms: ["Ed25519", "ES256"] }),
  });
  const webhook = lazyWebhook(permdockCloud, env.webhookSecret);
  return {
    store: permdockCloud.approvals,
    sink: permdockCloud.sink,
    webhook,
    inbox: CLOUD_INBOX,
    policies: permdockCloud.policies,
  };
}
