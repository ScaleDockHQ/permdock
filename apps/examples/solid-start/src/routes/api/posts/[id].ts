import { protect } from "../../../lib/permdock.ts";
import { ownPost, permissions } from "../../../lib/permissions.ts";

export const PATCH = protect(permissions.post.update, (event) =>
  event.params["id"] === ownPost.id ? ownPost : null,
)((event) => Response.json({ ok: true, id: event.locals.permdockData.id }));
