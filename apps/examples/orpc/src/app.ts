import { implement } from "@orpc/server";
import { createPermDock } from "permdock/orpc";

import { contract } from "./contract.ts";
import { ownPost, permissions } from "./permissions.ts";
import { policy, type User } from "./policy.ts";

type Ctx = { readonly user: User };

const { permdock, protect } = createPermDock<Ctx>(policy, {
  subject: (opts) => opts.context.user,
});

const os = implement(contract).$context<Ctx>();
const base = os.use(permdock());

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
