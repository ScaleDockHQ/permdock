import { memoryApprovalStore } from "permdock/approvals";
import { joseTokenSigner, joseTokenVerifier } from "permdock/jwt";
import { createPermDock } from "permdock/workflow";

import { automations, policy, principals } from "./policy.ts";

const ISSUER = "https://workflow-sdk.permdock.localhost";
const AUDIENCE = `${ISSUER}/runs`;
const KID = "demo";

async function createRuns() {
  // A per-process key: run tickets do not survive a restart. Load a stored key in production.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const {
    d,
    key_ops: _keyOps,
    ext: _ext,
    ...publicKey
  } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const approvals = memoryApprovalStore();
  const workflow = createPermDock(policy, {
    signer: joseTokenSigner({
      key: { ...publicKey, d },
      alg: "Ed25519",
      kid: KID,
      issuer: ISSUER,
      audience: AUDIENCE,
    }),
    verifier: joseTokenVerifier({
      jwks: { keys: [{ ...publicKey, kid: KID, alg: "Ed25519" }] },
      algorithms: ["Ed25519"],
      issuer: ISSUER,
      audience: AUDIENCE,
    }),
    principals,
    automations,
    approvals,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { workflow, approvals };
}

type Runs = Awaited<ReturnType<typeof createRuns>>;

declare global {
  // Route handlers and Workflow SDK steps load separate copies of this module
  // in one process, so the demo key and memory stores live on `globalThis`.
  var permdockWorkflowSdkRuns: Promise<Runs> | undefined;
}

export async function runs(): Promise<Runs> {
  const created = await (globalThis.permdockWorkflowSdkRuns ??= createRuns());
  return created;
}
