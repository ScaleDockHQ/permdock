import { implement } from "@orpc/server";
import { createPermDock } from "permdock/orpc";

import type { User } from "./policy.ts";

import { contract } from "./contract.ts";
import { operations, postRef } from "./operations.ts";
import { ownPost, permissions } from "./permissions.ts";
import { policy } from "./policy.ts";

type Ctx = { readonly user: User };

const { middleware, protect, operationsRouter } = createPermDock<Ctx>(policy, {
  subject: (opts) => opts.context.user,
});

const os = implement(contract).$context<Ctx>();
const base = os.use(middleware());

export const router = os.router({
  health: os.health.handler(() => ({ ok: true as const })),
  posts: {
    update: base.posts.update
      .use(protect(permissions.post.update, () => ownPost))
      .handler(() => ({ ok: true as const })),
    publish: base.posts.publish
      .use(protect(permissions.post.publish, () => ownPost))
      .handler(() => ({ ok: true as const })),
  },
});

// One procedure per operation, guarded by its permission and data loader.
export const operationsRoutes = operationsRouter(operations, {
  "posts.read": {
    input: postRef,
    handler: ({ context }) => context.permdockData,
  },
  "posts.list": {
    handler: ({ context }) =>
      context.permdock.filter(permissions.post.read, [ownPost]).length,
  },
});
