import "reflect-metadata";
import { Controller, Get, Module, Patch, Post } from "@nestjs/common";
import { createPermDock, decorateMethod } from "permdock/nest";

import { ownPost, permissions } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";

export const { PermDockModule, Protect, permdockHandler } = createPermDock(
  policy,
  {
    subject: () => memberUser,
  },
);

class HealthController {
  health() {
    return { ok: true };
  }
}
Controller()(HealthController);
decorateMethod(HealthController, "health", Get("health"));

class PostsController {
  update() {
    return { ok: true };
  }

  publish() {
    return { ok: true };
  }
}
Controller("posts")(PostsController);
decorateMethod(
  PostsController,
  "update",
  Patch(":id"),
  Protect(permissions.post.update, () => ownPost),
);
decorateMethod(
  PostsController,
  "publish",
  Post(":id/publish"),
  Protect(permissions.post.publish, () => ownPost),
);

class AppModule {}
Module({
  imports: [PermDockModule.forRoot({ guard: "global" })],
  controllers: [HealthController, PostsController, permdockHandler()],
})(AppModule);

export { AppModule };
