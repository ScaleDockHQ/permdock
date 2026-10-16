import type { DecisionProvider, Permission } from "permdock";
import type { AuthzenEvaluationVector } from "permdock/testing";

import { joseTokenSigner } from "permdock/jwt";
import { describePolicy, testCloudApi } from "permdock/testing";
import { describe, expect, it } from "vitest";

import { env } from "../src/env.ts";
import { clientCredentials, cloudPdp } from "../src/pep-cloud.ts";
import { localPdp, pepFor } from "../src/pep.ts";
import { otherPost, ownPost, permissions } from "../src/permissions.ts";
import { type User, adminUser, memberUser, policy } from "../src/policy.ts";
import { permdockHandler } from "../src/server.ts";

type Outcome = "granted" | "denied" | "approval-required";
type Cells = { readonly member: Outcome; readonly admin: Outcome };
type Post = typeof ownPost;

const subjects = { member: memberUser, admin: adminUser };

type Case = {
  readonly name: string;
  readonly permission: Permission;
  readonly user: User;
  readonly data: Post | null;
  readonly expected: Outcome;
};

const matrix: Record<string, Cells | Record<string, Cells>> = {};
const cases: Case[] = [];

function instance(permission: Permission, own: Cells, other: Cells): void {
  matrix[permission.key] = { ownPost: own, otherPost: other };
  for (const [fixture, data, cells] of [
    ["ownPost", ownPost, own],
    ["otherPost", otherPost, other],
  ] as const) {
    for (const name of ["member", "admin"] as const) {
      cases.push({
        name: `${permission.key} ${fixture} / ${name}`,
        permission,
        user: subjects[name],
        data,
        expected: cells[name],
      });
    }
  }
}

function collection(permission: Permission, cells: Cells): void {
  matrix[permission.key] = cells;
  for (const name of ["member", "admin"] as const) {
    cases.push({
      name: `${permission.key} / ${name}`,
      permission,
      user: subjects[name],
      data: null,
      expected: cells[name],
    });
  }
}

const both: Cells = { member: "granted", admin: "granted" };
instance(permissions.post.read, both, both);
instance(permissions.post.update, both, { member: "denied", admin: "granted" });
instance(
  permissions.post.delete,
  { member: "approval-required", admin: "granted" },
  { member: "denied", admin: "granted" },
);
instance(
  permissions.post.publish,
  { member: "denied", admin: "granted" },
  { member: "denied", admin: "denied" },
);
collection(permissions.post.create, both);
collection(permissions.post.list, both);

describePolicy(policy, {
  subjects,
  fixtures: { ownPost, otherPost },
  matrix,
});

function parity(provider: () => DecisionProvider): void {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const pep = pepFor(provider(), testCase.user);
      const decision =
        testCase.data === null
          ? await pep.decide(testCase.permission)
          : await pep.decide(testCase.permission, testCase.data);
      expect(decision.outcome).toBe(testCase.expected);
    });
  }
}

describe("the PEP decides like the policy through the local PDP", () => {
  const pdp = permdockHandler();
  parity(() =>
    localPdp({
      url: "http://127.0.0.1:3470",
      fetch: async (input, init) => {
        const response = await pdp(new Request(input, init));
        return response;
      },
    }),
  );

  it("denies a locally granted read when the PDP is unreachable", async () => {
    const pep = pepFor(
      localPdp({
        url: "http://127.0.0.1:3470",
        fetch: async () => {
          await Promise.resolve();
          return Response.error();
        },
      }),
      memberUser,
    );
    expect(await pep.decide(permissions.post.read, ownPost)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "pdp-unavailable" }],
    });
  });
});

const { cloud, cloudKey, approverJwk, approverIssuer } = env;

if (cloud !== null) {
  describe("the PEP decides like the policy through the hosted ADS", () => {
    parity(() => cloudPdp(cloud));
  });
}

if (
  cloud !== null &&
  cloudKey !== null &&
  approverJwk !== null &&
  approverIssuer !== null
) {
  const token = await clientCredentials(cloud)();
  const evaluation: AuthzenEvaluationVector[] = cases.flatMap((testCase) =>
    testCase.data === null
      ? []
      : [
          {
            request: {
              subject: {
                type: "user",
                id: testCase.user.id,
                properties: {
                  orgId: testCase.user.orgId,
                  roles: testCase.user.roles,
                },
              },
              action: { name: testCase.permission.action },
              resource: {
                type: testCase.permission.resource,
                id: testCase.data.id,
                properties: testCase.data,
              },
            },
            expected: testCase.expected === "granted",
          },
        ],
  );
  // SAFETY: the variable holds a private JWK the environment trusts as an issuer.
  const key = JSON.parse(approverJwk) as Record<string, unknown>;
  testCloudApi(
    cloud.url,
    { client: cloudKey },
    {
      environment: cloud.environment,
      approver: {
        signer: joseTokenSigner({
          key,
          alg: "ES256",
          kid: typeof key["kid"] === "string" ? key["kid"] : "approver",
          issuer: approverIssuer,
        }),
      },
      authzen: {
        vectors: { evaluation },
        headers: { authorization: `Bearer ${token}` },
      },
    },
  );
}
