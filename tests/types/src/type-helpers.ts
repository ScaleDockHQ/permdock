import type {
  OperationNameOf,
  PermDock,
  PermissionOf,
  PlanNameOf,
  RowOf,
  ScopeNameOf,
  VocabularyOf,
} from "permdock";

import {
  allow,
  defineOperations,
  definePermissions,
  definePlans,
  definePolicy,
  getPermDockSync,
  resource,
  role,
} from "permdock";
import { z } from "zod";

const Post = z.object({ id: z.string(), published: z.boolean() });

export const permissions = definePermissions({
  post: resource(Post, { id: "id", actions: ["read", "update"] }),
});

export const plans = definePlans({ pro: {} });

export const policy = definePolicy(
  { permissions, plans },
  {
    roles: [role("editor", [allow(permissions.post.update)])],
    scopes: { org: { key: "orgId" } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id, roles: ["editor"] },
  },
);

const operations = defineOperations(permissions, {
  publishPost: { permission: permissions.post.update },
});

export const leaf: PermissionOf<typeof permissions> = permissions.post.read;
export const plan: PlanNameOf<typeof policy> = "pro";
export const scope: ScopeNameOf<typeof policy> = "org";
export const operation: OperationNameOf<typeof operations> = "publishPost";
export const row: RowOf<typeof permissions.post.update> = {
  id: "p1",
  published: true,
};

const permdock: PermDock<VocabularyOf<typeof policy>> = getPermDockSync(
  policy,
  { id: "u1" },
);
export const allowed: boolean = permdock.can(permissions.post.update, {
  published: true,
});
// @ts-expect-error published is a boolean
permdock.can(permissions.post.update, { published: "yes" });
