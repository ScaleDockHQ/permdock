import { protect } from "../../../../lib/permdock.ts";
import { ownPost, permissions } from "../../../../lib/permissions.ts";

export const POST = protect(permissions.post.publish, (event) =>
  event.params["id"] === ownPost.id ? ownPost : null,
)(() => Response.json({ ok: true }));
