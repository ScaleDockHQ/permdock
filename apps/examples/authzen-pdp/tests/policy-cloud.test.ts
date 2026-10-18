import type { Policy } from "permdock";

import { readFileSync } from "node:fs";
import { getPermDockSync } from "permdock";
import { pushedPolicy } from "permdock/catalog";
import { beforeAll, describe, expect, it } from "vitest";

import { type ProjectEnv, env } from "../src/env.ts";
import { otherPost, ownPost, permissions } from "../src/permissions.ts";
import { cloudPolicy } from "../src/policy-cloud.ts";
import { type User, adminUser, memberUser, policy } from "../src/policy.ts";

const catalog: unknown = JSON.parse(
  readFileSync(new URL("../permissions.catalog.json", import.meta.url), "utf8"),
);

const reference = {
  url: "https://cloud.test/api",
  project: "prj_test",
  token: "pt_read_test",
};

const instances = [
  permissions.post.read,
  permissions.post.update,
  permissions.post.delete,
  permissions.post.publish,
];
const collections = [permissions.post.create, permissions.post.list];

function decidesLikeTheLocalPolicy(
  project: ProjectEnv,
  fetcher: typeof fetch = fetch,
): void {
  let rebuilt: Policy<User> | null = null;
  beforeAll(async () => {
    rebuilt = await cloudPolicy(project, fetcher);
  });
  const hostedFor = (user: User) => {
    if (rebuilt === null) {
      throw new Error("beforeAll did not load the project's policy");
    }
    return getPermDockSync(rebuilt, user);
  };
  for (const user of [memberUser, adminUser]) {
    for (const permission of instances) {
      for (const post of [ownPost, otherPost]) {
        it(`${permission.key} ${post.id} / ${user.id}`, () => {
          const hosted = hostedFor(user);
          const local = getPermDockSync(policy, user);
          expect(hosted.decide(permission, post).outcome).toBe(
            local.decide(permission, post).outcome,
          );
        });
      }
    }
    for (const permission of collections) {
      it(`${permission.key} / ${user.id}`, () => {
        const hosted = hostedFor(user);
        const local = getPermDockSync(policy, user);
        expect(hosted.decide(permission).outcome).toBe(
          local.decide(permission).outcome,
        );
      });
    }
  }
}

const stub: typeof fetch = async (input, init) => {
  await Promise.resolve();
  const url = input instanceof Request ? input.url : input.toString();
  const headers = new Headers(init?.headers);
  return url === `${reference.url}/v1/projects/${reference.project}/policy` &&
    headers.get("authorization") === `Bearer ${reference.token}`
    ? Response.json({ catalog, policy: pushedPolicy(policy) })
    : new Response(null, { status: 401 });
};

describe("the policy rebuilt from a pushed policy decides like the local one", () => {
  decidesLikeTheLocalPolicy(reference, stub);

  it("throws when the project has nothing published", async () => {
    await expect(
      cloudPolicy(reference, async () => {
        await Promise.resolve();
        return Response.json(
          { type: "https://permdock.com/problems/policy-not-published" },
          { status: 404 },
        );
      }),
    ).rejects.toThrow(/404/u);
  });
});

const { project } = env;

if (project !== null) {
  describe("the project's pushed policy decides like the local one", () => {
    decidesLikeTheLocalPolicy(project);
  });
}
