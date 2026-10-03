import {
  allow,
  anyone,
  createPermDock,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  resource,
  role,
  principal,
} from "permdock";
import { z } from "zod";

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read", "update", "delete"],
    collection: ["list", "create"],
  }),
});

const roles = defineRoles({
  member: {},
});

const plans = definePlans({
  pro: {},
});

const member = role(roles.member, [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.update, { where: { authorId: principal.id } }),
]);

export const policy = definePolicy(
  { permissions, roles, plans },
  {
    roles: [member],
    grants: [allow(permissions.post.read, { to: anyone() })],
    principal: (
      user: { readonly id: string; readonly roles: readonly string[] } | null,
    ) => user,
  },
);

export async function check(): Promise<boolean> {
  const permdock = await createPermDock(policy, {
    id: "u1",
    roles: ["member"],
  });
  const trees =
    permdock.roles.member.key === "member" && permdock.plans.pro.key === "pro";
  return permdock.can(permissions.post.list) && trees;
}
