import { SignJWT, importJWK } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthEvent } from "../../src/core/event-types.ts";

import { subjectFromCiOidc } from "../../src/jwt/index.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "ci",
  alg: "Ed25519",
} as const;

const JWKS = {
  keys: [
    {
      crv: "Ed25519",
      x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
      kty: "OKP",
      kid: "ci",
      alg: "Ed25519",
    },
  ],
};

const AUDIENCE = "https://deploy.acme.dev";

async function ciToken(
  issuer: string,
  claims: Record<string, unknown>,
  audience = AUDIENCE,
): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, "Ed25519");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "Ed25519", kid: "ci", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

describe(subjectFromCiOidc, () => {
  it("maps a GitHub Actions token to a workload", async () => {
    const token = await ciToken("https://token.actions.githubusercontent.com", {
      sub: "repo:acme/api:environment:production",
      repository: "acme/api",
      ref: "refs/heads/main",
      environment: "production",
    });
    const subject = await subjectFromCiOidc(token, {
      provider: "github",
      audience: AUDIENCE,
      jwks: JWKS,
    });
    expect(subject.principal).toStrictEqual({
      id: "repo:acme/api:environment:production",
      kind: "workload",
      issuer: "https://token.actions.githubusercontent.com",
      provider: "github",
      repository: "acme/api",
      ref: "refs/heads/main",
      environment: "production",
    });
  });

  it("maps a Vercel OIDC token to a workload with the team and project ids", async () => {
    const token = await ciToken(
      "https://oidc.vercel.com",
      {
        sub: "owner:acme:project:api:environment:preview",
        owner: "acme",
        owner_id: "team_7Gw5ZMzpQA8h90F832KGp7nwbuh3",
        project: "api",
        project_id: "prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3",
        environment: "preview",
        user_id: "u_should_not_appear",
      },
      "https://vercel.com/acme",
    );
    const subject = await subjectFromCiOidc(token, {
      provider: "vercel",
      audience: "https://vercel.com/acme",
      jwks: JWKS,
    });
    expect(subject.principal).toStrictEqual({
      id: "owner:acme:project:api:environment:preview",
      kind: "workload",
      issuer: "https://oidc.vercel.com",
      provider: "vercel",
      owner: "team_7Gw5ZMzpQA8h90F832KGp7nwbuh3",
      project: "prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3",
      environment: "preview",
    });
  });

  it("accepts a Vercel team issuer only when it is configured", async () => {
    const token = await ciToken(
      "https://oidc.vercel.com/acme",
      { sub: "owner:acme:project:api:environment:production" },
      "https://vercel.com/acme",
    );
    const global = await subjectFromCiOidc(token, {
      provider: "vercel",
      audience: "https://vercel.com/acme",
      jwks: JWKS,
    });
    expect(global.principal).toBeNull();
    const team = await subjectFromCiOidc(token, {
      provider: "vercel",
      issuer: "https://oidc.vercel.com/acme",
      audience: "https://vercel.com/acme",
      jwks: JWKS,
    });
    expect(team.principal).toMatchObject({
      kind: "workload",
      issuer: "https://oidc.vercel.com/acme",
    });
  });

  it("normalises GitLab and Buildkite refs", async () => {
    const gitlab = await subjectFromCiOidc(
      await ciToken("https://gitlab.com", {
        sub: "project_path:acme/api:ref_type:tag:ref:v1.2.0",
        project_path: "acme/api",
        ref: "v1.2.0",
        ref_type: "tag",
      }),
      { provider: "gitlab", audience: AUDIENCE, jwks: JWKS },
    );
    expect(gitlab.principal).toMatchObject({
      kind: "workload",
      repository: "acme/api",
      ref: "refs/tags/v1.2.0",
    });
    const buildkite = await subjectFromCiOidc(
      await ciToken("https://agent.buildkite.com", {
        sub: "organization:acme:pipeline:api:ref:refs/heads/main:commit:abc:step:deploy",
        organization_slug: "acme",
        pipeline_slug: "api",
        build_branch: "main",
      }),
      { provider: "buildkite", audience: AUDIENCE, jwks: JWKS },
    );
    expect(buildkite.principal).toMatchObject({
      repository: "acme/api",
      ref: "refs/heads/main",
    });
  });

  it("is anonymous for another issuer, audience or a failing schema", async () => {
    const events: AuthEvent[] = [];
    const options = {
      provider: "github" as const,
      audience: AUDIENCE,
      jwks: JWKS,
      onAuth: (event: AuthEvent): void => {
        events.push(event);
      },
    };
    const claims = {
      sub: "repo:acme/api:ref:refs/heads/main",
      repository: "acme/api",
    };
    const wrongIssuer = await subjectFromCiOidc(
      await ciToken("https://gitlab.com", claims),
      options,
    );
    const wrongAudience = await subjectFromCiOidc(
      await ciToken(
        "https://token.actions.githubusercontent.com",
        claims,
        "https://other.example",
      ),
      options,
    );
    const outsideRepo = await subjectFromCiOidc(
      await ciToken("https://token.actions.githubusercontent.com", claims),
      {
        ...options,
        schema: z.object({ repository: z.literal("acme/deployments") }),
      },
    );
    expect(
      [wrongIssuer, wrongAudience, outsideRepo].map((s) => s.principal),
    ).toStrictEqual([null, null, null]);
    expect(events.map((event) => event.source)).toStrictEqual([
      "ci-oidc",
      "ci-oidc",
      "ci-oidc",
    ]);
    expect(events[2]?.cause).toBe("invalid-claims");
  });

  it("is anonymous without a token or an audience, and never throws", async () => {
    const { principal } = await subjectFromCiOidc(undefined, {
      provider: "github",
      audience: AUDIENCE,
    });
    expect(principal).toBeNull();
    const token = await ciToken("https://token.actions.githubusercontent.com", {
      sub: "repo:acme/api",
    });
    expect(
      (
        await subjectFromCiOidc(token, {
          provider: "github",
          audience: "",
          jwks: JWKS,
        })
      ).principal,
    ).toBeNull();
    // SAFETY: deliberately unknown provider to exercise the anonymous fallback.
    expect(
      (
        await subjectFromCiOidc(token, {
          provider: "jenkins" as "github",
          audience: AUDIENCE,
          jwks: JWKS,
        })
      ).principal,
    ).toBeNull();
  });
});
