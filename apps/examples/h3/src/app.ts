import { H3 } from "h3";
import { createPermDock } from "permdock/h3";

import { ownPost, permissions } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";

const { middleware, protect, withPermDock, permdockHandler } = createPermDock(
  policy,
  { subject: () => memberUser },
);

export const app = new H3();

app.use(middleware());

app.get("/health", () => ({ ok: true }));

app.patch(
  "/posts/:id",
  withPermDock<typeof ownPost>((event) => ({
    ok: true,
    id: event.context.permdockData.id,
  })),
  { middleware: [protect(permissions.post.update, () => ownPost)] },
);

app.post("/posts/:id/publish", () => ({ ok: true }), {
  middleware: [protect(permissions.post.publish, () => ownPost)],
});

app.all("/api/permdock", permdockHandler());
