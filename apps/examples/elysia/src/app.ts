import { Elysia } from "elysia";
import { createPermDock } from "permdock/elysia";

import { ownPost, permissions } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";

const { middleware, protect } = createPermDock(policy, {
  subject: () => memberUser,
});

export const app = new Elysia()
  .use(middleware())
  .get("/health", () => ({ ok: true }))
  .patch("/posts/:id", () => ({ ok: true }), {
    beforeHandle: protect(permissions.post.update, () => ownPost),
  })
  .post("/posts/:id/publish", () => ({ ok: true }), {
    beforeHandle: protect(permissions.post.publish, () => ownPost),
  });
