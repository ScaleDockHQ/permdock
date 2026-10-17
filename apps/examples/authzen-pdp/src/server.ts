import { createPermDock } from "permdock/authzen";

import { PEP_TOKEN } from "./pep.ts";
import { otherPost, ownPost } from "./permissions.ts";
import { type User, adminUser, memberUser, policy } from "./policy.ts";

/** The caller `src/pep.ts` authenticates as; only it may name a subject in the body. */
const pepCaller: User = { id: "pep", orgId: "o1", roles: [] };

const posts = new Map<string, typeof ownPost>([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);

export const { permdockHandler } = createPermDock(policy, {
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
  subjects: {
    list: () => [memberUser, adminUser],
  },
});
