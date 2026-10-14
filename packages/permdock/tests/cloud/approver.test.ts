import { describe, expect, it } from "vitest";

import type { ApprovalVerdict } from "../../src/approvals/types.ts";
import type { TokenSigner } from "../../src/core/interfaces.ts";

import { isApprovalError } from "../../src/approvals/errors.ts";
import { cloud } from "../../src/cloud/create.ts";
import { cloudSigner } from "../../src/cloud/signer.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";

const CLOUD_URL = "https://cloud.permdock.test";
const CLOUD_ENV = `${CLOUD_URL}/v1/environments/production`;
const APP_ISSUER = "https://app.example.com";
const KEY = "env-key";
const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "app-2026",
  alg: "Ed25519",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;

const signer = joseTokenSigner({
  key: { ...PRIVATE_JWK },
  alg: "Ed25519",
  kid: "app-2026",
  issuer: APP_ISSUER,
});
const verifier = joseTokenVerifier({
  jwks: { keys: [PUBLIC_JWK] },
  algorithms: ["Ed25519"],
});

const APPROVED = {
  token: "opaque-token",
  id: "apr_1",
  v: 1,
  permission: "post.delete",
  scope: "post:delete",
  resource: { type: "post", id: "42" },
  subject: { principal: { id: "u_1", roles: ["member"] } },
  detail: "post.delete requires human approval.",
  createdAt: "2026-10-14T08:00:00Z",
  expiresAt: "2099-10-14T09:00:00Z",
  status: "approved",
};

type Sent = {
  readonly path: string;
  readonly approval: string | null;
  readonly approver: string | null;
  readonly body: unknown;
};

function recorder(): { readonly fetch: typeof fetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      sent.push({
        path: new URL(request.url).pathname,
        approval: request.headers.get("PermDock-Approval"),
        approver: request.headers.get("PermDock-Approver"),
        body: await request.json(),
      });
      return new Response(JSON.stringify(APPROVED), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const approve: ApprovalVerdict = {
  status: "approved",
  by: { principal: { id: "u_9", roles: ["admin"] }, context: {} },
};

async function refusal(result: unknown): Promise<unknown> {
  return Promise.resolve(result).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("cloud().approvals.resolve and PermDock-Approver", () => {
  it("sends an at+jwt the approver signer issued for <issuer>/approvals", async () => {
    const backend = recorder();
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: backend.fetch,
      approver: { signer },
    });
    expect((await client.approvals.resolve("opaque-token", approve)).id).toBe(
      "apr_1",
    );
    const [sent] = backend.sent;
    expect(sent?.path).toBe(
      "/v1/environments/production/approvals/by-token/resolve",
    );
    expect(sent?.approval).toBe("opaque-token");
    const verified = await verifier.verify(sent?.approver ?? "", {
      typ: "at+jwt",
      issuer: APP_ISSUER,
      audience: `${CLOUD_ENV}/approvals`,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      return;
    }
    expect(verified.header.typ).toBe("at+jwt");
    expect(verified.claims.sub).toBe("u_9");
    expect(verified.claims).not.toHaveProperty("act");
    expect(verified.claims["jti"]).toEqual(expect.any(String));
    const { iat, exp } = verified.claims;
    expect(typeof iat === "number" && typeof exp === "number").toBe(true);
    expect(Number(exp) - Number(iat)).toBe(60);
  });

  it("signs a fresh token per resolve and uses the configured audience", async () => {
    const backend = recorder();
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: backend.fetch,
      approver: { signer, audience: "https://cloud.example/approvers" },
    });
    await client.approvals.resolve("opaque-token", approve);
    await client.approvals.resolve("opaque-token", approve);
    const [first, second] = backend.sent;
    expect(first?.approver).not.toBe(second?.approver);
    const verified = await verifier.verify(first?.approver ?? "", {
      typ: "at+jwt",
      issuer: APP_ISSUER,
      audience: "https://cloud.example/approvers",
    });
    expect(verified.ok).toBe(true);
  });

  it("refuses to resolve without an approver signer and sends nothing", async () => {
    const backend = recorder();
    const client = cloud({ url: CLOUD_URL, key: KEY, fetch: backend.fetch });
    const refused = await refusal(
      client.approvals.resolve("opaque-token", approve),
    );
    expect(isApprovalError(refused)).toBe(true);
    expect(refused).toMatchObject({ code: "approver-unauthenticated" });
    expect(backend.sent).toEqual([]);
  });

  it.each<[string, ApprovalVerdict]>([
    [
      "an anonymous approver",
      { status: "approved", by: { principal: null, context: {} } },
    ],
    [
      "an empty principal id",
      {
        status: "approved",
        by: { principal: { id: "", roles: [] }, context: {} },
      },
    ],
  ])("refuses %s as unauthenticated", async (_name, verdict) => {
    const backend = recorder();
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: backend.fetch,
      approver: { signer },
    });
    const refused = await refusal(
      client.approvals.resolve("opaque-token", verdict),
    );
    expect(refused).toMatchObject({ code: "approver-unauthenticated" });
    expect(backend.sent).toEqual([]);
  });

  it.each<[string, ApprovalVerdict]>([
    [
      "an agent acting for the approver",
      {
        status: "approved",
        by: {
          principal: { id: "u_9", roles: ["admin"] },
          actor: { id: "agent_1", kind: "agent" },
          context: {},
        },
      },
    ],
    [
      "a system approval",
      {
        status: "approved",
        by: {
          principal: { id: "svc", roles: [] },
          actor: { id: "expiry", kind: "system" },
          context: {},
        },
      },
    ],
  ])("refuses %s as not eligible", async (_name, verdict) => {
    const backend = recorder();
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: backend.fetch,
      approver: { signer },
    });
    const refused = await refusal(
      client.approvals.resolve("opaque-token", verdict),
    );
    expect(refused).toMatchObject({ code: "approver-not-eligible" });
    expect(backend.sent).toEqual([]);
  });

  it("sends a system rejection without an approver token", async () => {
    const backend = recorder();
    const client = cloud({ url: CLOUD_URL, key: KEY, fetch: backend.fetch });
    const verdict: ApprovalVerdict = {
      status: "rejected",
      by: {
        principal: { id: "svc", roles: [] },
        actor: { id: "ssf", kind: "system" },
        context: {},
      },
      note: "session revoked",
    };
    await client.approvals.resolve("opaque-token", verdict);
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.approver).toBeNull();
    expect(backend.sent[0]?.body).toMatchObject({ status: "rejected" });
  });

  it("fails closed when the signer throws", async () => {
    const backend = recorder();
    const broken: TokenSigner = {
      sign: () => Promise.reject(new Error("kms down")),
    };
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: backend.fetch,
      approver: { signer: broken },
    });
    const refused = await refusal(
      client.approvals.resolve("opaque-token", approve),
    );
    expect(refused).toMatchObject({ code: "approver-unauthenticated" });
    expect(backend.sent).toEqual([]);
  });

  it("cloudSigner never mints an approver token", async () => {
    let calls = 0;
    const tickets = cloudSigner({
      url: CLOUD_URL,
      key: KEY,
      audience: `${CLOUD_ENV}/approvals`,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("a.b.c"));
      },
    });
    await expect(
      tickets.sign({ sub: "u_9" }, { typ: "at+jwt" }),
    ).rejects.toThrow(/never signs at\+jwt/);
    expect(calls).toBe(0);
  });
});
