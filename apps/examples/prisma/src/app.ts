import type { Context } from "hono";

import { Hono } from "hono";
import { createPermDock } from "permdock/hono";
import { toWhere } from "permdock/prisma";

import type { Prisma } from "./generated/client.ts";

import { db, requiredFields } from "./db.ts";
import { permissions } from "./permissions.ts";
import { memberUser, policy } from "./policy.ts";

const { permdock, protect } = createPermDock(policy, {
  subject: () => memberUser,
});

async function loadPost(c: Context) {
  const prisma = await db;
  return prisma.post.findUnique({
    where: { id: c.req.param("id") ?? "" },
    select: { id: true, authorId: true, orgId: true, published: true },
  });
}

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/posts", permdock(), async (c) => {
  const prisma = await db;
  const rows = await prisma.post.findMany({
    where: toWhere<Prisma.postWhereInput>(
      c.get("permdock").where(permissions.post.list),
      { requiredFields },
    ),
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return c.json({ ok: true, posts: rows.map((row) => row.id) });
});

app.patch(
  "/posts/:id",
  protect(permissions.post.update, loadPost),
  async (c) => {
    const prisma = await db;
    await prisma.post.updateMany({
      where: {
        AND: [
          { id: c.req.param("id") },
          toWhere<Prisma.postWhereInput>(
            c.get("permdock").where(permissions.post.update),
            { requiredFields },
          ),
        ],
      },
      data: { title: "Edited" },
    });
    return c.json({ ok: true, id: c.req.param("id") });
  },
);

app.post(
  "/posts/:id/publish",
  protect(permissions.post.publish, loadPost),
  (c) => c.json({ ok: true }),
);
