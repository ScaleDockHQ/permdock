import type { Principal } from "permdock";

import { allow, definePolicy, relation } from "permdock";
import { saasPermissions as p, saasRoles as r } from "permdock/testing/saas";

/**
 * The folder grants of `saasPolicy`, verbatim. The full policy also carries
 * plan gates, a closure deny and a quota, which RLS cannot compile, so
 * `rls generate` refuses it as a whole.
 */
export const policy = definePolicy(
  { permissions: p, roles: r },
  {
    scopes: {
      tenant: { key: "orgId" },
      team: { key: "teamId", within: "tenant" },
    },
    subject: (user: Principal | null): Principal | null => user,
    grants: [
      allow(p.folder.read, { to: r.admin }),
      allow(p.folder.read, { to: r.owner }),
      allow(p.folder.read, {
        to: relation(p.folder, "viewer", { through: "parent", depth: 8 }),
      }),
      allow(p.folder.update, {
        to: relation(p.folder, "editor", { through: "parent", depth: 8 }),
      }),
    ],
  },
);
