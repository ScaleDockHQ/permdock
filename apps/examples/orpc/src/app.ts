import { implement } from "@orpc/server";
import { createPermDock } from "permdock/orpc";

import type { User } from "./policy.ts";

import { contract } from "./contract.ts";
import { ownPost, permissions } from "./permissions.ts";
import { policy } from "./policy.ts";

type Ctx = { readonly user: User };

const { middleware, protect } = createPermDock<Ctx>(policy, {
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
