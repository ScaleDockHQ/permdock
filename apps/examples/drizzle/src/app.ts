import type { Context } from "hono";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { toWhere } from "permdock/drizzle";
import { createPermDock } from "permdock/hono";

import { db, ready } from "./db.ts";
import { permissions } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";
import { posts } from "./schema.ts";

const { permdock, protect } = createPermDock(policy, {
  subject: () => memberUser,
});

async function loadPost(c: Context) {
  await ready;
  const [row] = await db
    .select({
      id: posts.id,
      authorId: posts.authorId,
      orgId: posts.orgId,
      published: posts.published,
    })
    .from(posts)
    .where(eq(posts.id, c.req.param("id") ?? ""));
  return row;
}

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/posts", permdock(), async (c) => {
  await ready;
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(toWhere(c.get("permdock").where(permissions.post.list), posts))
    .orderBy(posts.id);
  return c.json({ ok: true, posts: rows.map((row) => row.id) });
});

app.patch(
  "/posts/:id",
  protect(permissions.post.update, loadPost),
  async (c) => {
    const updated = await db
      .update(posts)
      .set({ title: "Edited" })
      .where(
        and(
          eq(posts.id, c.req.param("id")),
          toWhere(c.get("permdock").where(permissions.post.update), posts),
        ),
      )
      .returning({ id: posts.id });
    return c.json({ ok: true, id: updated[0]?.id });
  },
);

app.post(
  "/posts/:id/publish",
  protect(permissions.post.publish, loadPost),
  (c) => c.json({ ok: true }),
);
