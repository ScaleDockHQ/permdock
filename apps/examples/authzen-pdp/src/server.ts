import type { Policy } from "permdock";

import { createPermDock } from "permdock/authzen";

import type { User } from "./policy.ts";

import { PEP_TOKEN } from "./pep.ts";
import { otherPost, ownPost } from "./permissions.ts";
import { adminUser, memberUser, policy } from "./policy.ts";

/**
 * The caller `src/pep.ts` authenticates as; only it may name a subject in the
 * body.
 */
const pepCaller: User = { id: "pep", orgId: "o1", roles: [] };

const posts = new Map<string, typeof ownPost>([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);

/**
 * The PDP over any policy for these permissions: the local one, or one rebuilt
 * from the Cloud.
 */
export function createPdp(source: Policy<User>) {
  return createPermDock(source, {
    subject: (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization === "Bearer test") {
        return memberUser;
      }
      return authorization === `Bearer ${PEP_TOKEN}` ? pepCaller : null;
    },
    trustedPep: (pep) => pep === pepCaller,
    resources: {
      post: {
        data: (id) => posts.get(id) ?? null,
        list: () => [...posts.values()],
      },
    },
    subjects: { list: () => [memberUser, adminUser] },
  });
}

export const { permdockHandler } = createPdp(policy);
