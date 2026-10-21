import { z } from "zod";

import type { ToolBinding } from "../../src/agent/types.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read", "update", "delete", "publish"],
    collection: ["create", "list"],
  }),
});

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

const member = role("member", [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { where: { authorId: principal.id } }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: "human",
  }),
]);

const admin = role("admin", [
  ...member.grants,
  allow(permissions.post.update),
  allow(permissions.post.delete),
  allow(permissions.post.publish),
  deny(permissions.post.publish, { where: { published: true } }),
]);

export const policy = definePolicy(permissions, {
  roles: [member, admin],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: "boundary",
});

export const ownPost = {
  id: "p1",
  authorId: "u1",
  orgId: "o1",
  published: false,
};

export const otherPost = {
  id: "p2",
  authorId: "u9",
  orgId: "o1",
  published: true,
};

export const memberUser: User = { id: "u1", orgId: "o1", roles: ["member"] };
export const adminUser: User = { id: "u2", orgId: "o1", roles: ["admin"] };

function postFromArgs(args: unknown): typeof ownPost {
  // SAFETY: every tool call in the agent tests passes an object args with an optional id.
  const id = (args as { readonly id?: string }).id;
  return id === "p1" ? ownPost : otherPost;
}

/**
 * The agent tool map: `{ id: "p1" }` loads `ownPost`, any other args
 * `otherPost`.
 */
export function postTools(): Readonly<
  Record<"delete_post" | "list_posts" | "publish_post", ToolBinding>
> {
  return {
    delete_post: { permission: permissions.post.delete, data: postFromArgs },
    list_posts: { permission: permissions.post.list },
    publish_post: { permission: permissions.post.publish, data: postFromArgs },
  };
}
