import { createPermDock } from "permdock/tanstack-start";

import { ownPost } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";

export const { middleware, protect, permdockHandler } = createPermDock(policy, {
  subject: () => memberUser,
});

/** The post behind `/api/posts/<id>` and `/api/posts/<id>/publish`. */
export function postFromPath(request: Request): typeof ownPost | null {
  const id = new URL(request.url).pathname.split("/")[3];
  return id === ownPost.id ? ownPost : null;
}
