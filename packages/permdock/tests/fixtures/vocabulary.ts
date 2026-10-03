import type { PermDock } from "../../src/core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../../src/core/policy.ts";
import type { Principal } from "../../src/core/subject.ts";

import {
  allow,
  definePlans,
  definePolicy,
  defineRoles,
  role,
} from "../../src/index.ts";
import { permissions } from "./quick-start.ts";

export { permissions };

export const roles = defineRoles({ editor: {}, viewer: {} });

export const plans = definePlans({ pro: {} });

export type User = { readonly id: string };

/** A policy whose vocabulary refines roles and plans, for the per-adapter generic propagation type tests. */
export const policy = definePolicy(
  { permissions, roles, plans },
  {
    roles: [
      role(roles.editor, [
        allow(permissions.post.update),
        allow(permissions.post.read),
      ]),
    ],
    subject: (user: User | null) =>
      user === null ? null : { id: user.id, roles: ["editor"] },
  },
);

/** The instance every adapter should hand out for `policy`. */
export type VocabularyPermDock = PermDock<{
  readonly permissions: typeof permissions;
  readonly roles: typeof roles;
  readonly plans: typeof plans;
}>;

/** The instance a policy's vocabulary gives: `PermDockOf<typeof policy>`. */
export type PermDockOf<P> =
  P extends Policy<never, Principal, infer V extends PolicyVocabulary>
    ? PermDock<V>
    : never;

/** The vocabulary a policy was defined with. */
export type PolicyVocabularyOf<P> =
  P extends Policy<never, Principal, infer V extends PolicyVocabulary>
    ? V
    : never;
