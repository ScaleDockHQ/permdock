import { protect } from "../../../lib/permdock.ts";
import { ownPost, permissions } from "../../../lib/permissions.ts";

export const PATCH = protect(permissions.post.update, (context) =>
  context.params["id"] === ownPost.id ? ownPost : null,
)((context) => Response.json({ ok: true, id: context.locals.permdockData.id }));
