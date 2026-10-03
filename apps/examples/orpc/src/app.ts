import { os } from "@orpc/server";
import { createPermDock } from "permdock/orpc";
import { z } from "zod";

import { ownPost, permissions } from "./permissions.ts";
import { policy, type User } from "./policy.ts";

type Ctx = { readonly user: User };

const { permdock, protect } = createPermDock<Ctx>(policy, {
  subject: (opts) => opts.context.user,
});

const base = os.$context<Ctx>().use(permdock());

export const router = {
  health: os.handler(() => ({ ok: true as const })),
  posts: {
    update: base
      .input(z.object({ id: z.string() }))
      .use(protect(permissions.post.update, () => ownPost))
      .handler(() => ({ ok: true as const })),
    publish: base
      .input(z.object({ id: z.string() }))
      .use(protect(permissions.post.publish, () => ownPost))
      .handler(() => ({ ok: true as const })),
  },
};
