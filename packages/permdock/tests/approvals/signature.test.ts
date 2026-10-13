import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type { TokenSigner } from "../../src/core/interfaces.ts";

import {
  approvalSignatureClaims,
  signApproval,
} from "../../src/approvals/signature.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
  alg: "Ed25519",
};
const ISSUER = "https://app.example.com";

const APPROVED: ApprovalRequest = {
  v: 1,
  id: "apr_1",
  token: "sha-256:abc",
  permission: "post.delete",
  scope: "post:delete",
  resource: { type: "post", id: "42" },
  subject: {
    principal: { id: "u_1", roles: ["member"], tenant: "o_1" },
    actor: { id: "agent_1", kind: "agent" },
  },
  detail: "post.delete requires human approval.",
  createdAt: "2026-10-13T09:00:00.000Z",
  expiresAt: "2026-10-13T10:00:00.000Z",
  status: "approved",
  approvals: [
    {
      by: "u_2",
      at: "2026-10-13T09:10:00.000Z",
      stage: 0,
      onBehalfOf: "u_3",
      delegation: "del_1",
    },
  ],
  resolvedAt: "2026-10-13T09:10:00.000Z",
  resolvedBy: "u_2",
};

describe("approvalSignatureClaims", () => {
  it("carries act, the approvals in snake_case and one authorization_details entry", () => {
    expect(approvalSignatureClaims(APPROVED)).toEqual({
      sub: "u_1",
      act: { sub: "agent_1" },
      token: "sha-256:abc",
      resolved_by: "u_2",
      approvals: [
        {
          by: "u_2",
          at: "2026-10-13T09:10:00.000Z",
          stage: 0,
          on_behalf_of: "u_3",
          delegation: "del_1",
        },
      ],
      authorization_details: [
        { type: "post", actions: ["delete"], identifier: "42" },
      ],
    });
  });

  it("omits sub and act for an anonymous request and reads the action from a foreign key", () => {
    const claims = approvalSignatureClaims({
      v: 1,
      id: "apr_2",
      token: "sha-256:abc",
      permission: "billing.refund",
      scope: "billing:refund",
      resource: { type: "invoice" },
      subject: { principal: null },
      detail: "billing.refund requires human approval.",
      createdAt: "2026-10-13T09:00:00.000Z",
      expiresAt: "2026-10-13T10:00:00.000Z",
      status: "approved",
    });
    expect(claims).toEqual({
      token: "sha-256:abc",
      approvals: [],
      authorization_details: [{ type: "invoice", actions: ["refund"] }],
    });
  });
});

describe("signApproval", () => {
  it("signs an approved request with jti, iat and exp from the record", async () => {
    const signer = joseTokenSigner({
      key: PRIVATE_JWK,
      alg: "Ed25519",
      kid: "2026-09",
      issuer: ISSUER,
    });
    const token = await signApproval(APPROVED, signer, ISSUER);
    expect(decodeProtectedHeader(token ?? "").typ).toBe(
      "vnd.permdock.approval+jwt",
    );
    expect(decodeJwt(token ?? "")).toMatchObject({
      iss: ISSUER,
      aud: ISSUER,
      jti: "apr_1",
      iat: Date.parse("2026-10-13T09:10:00.000Z") / 1000,
      exp: Date.parse("2026-10-13T10:00:00.000Z") / 1000,
      sub: "u_1",
      resolved_by: "u_2",
    });
  });

  it("signs nothing without a signer or for a request that is not approved", async () => {
    const signer: TokenSigner = {
      sign: () => Promise.reject(new Error("unexpected")),
    };
    expect(await signApproval(APPROVED, undefined, ISSUER)).toBeUndefined();
    expect(
      await signApproval({ ...APPROVED, status: "rejected" }, signer, ISSUER),
    ).toBeUndefined();
  });
});
