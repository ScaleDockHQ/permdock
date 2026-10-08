import { Hono } from "hono";
import {
  betterAuthRoleSource,
  subjectFromBetterAuth,
} from "permdock/better-auth";
import { createPermDock } from "permdock/hono";

import { ownPost, permissions } from "./permissions.ts";
import { policy } from "./policy.ts";

const session = {
  user: { id: "user-1", role: "support", email: "ada@example.com" },
  session: { id: "sess-1", activeOrganizationId: "o_acme" },
  members: [{ organizationId: "o_acme", role: "member" }],
};

const auth = {
  api: {
    listOrganizationRoles: async () => {
      await Promise.resolve();
      return [
        { role: "billing-admin", permission: { post: ["read", "create"] } },
      ];
    },
  },
};

const { protect } = createPermDock(policy, {
  subject: async () => {
    const subject = await subjectFromBetterAuth(auth, session);
    return subject;
  },
  customRoles: betterAuthRoleSource(auth, {
    assignable: [{ name: "member", statements: { post: ["read", "create"] } }],
  }),
});

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.patch(
  "/posts/:id",
  protect(permissions.post.update, () => ownPost),
  (c) =>
    c.json({ ok: true, tenant: c.get("permdock").subject.principal?.tenant }),
);

app.post(
  "/posts/:id/delete",
  protect(permissions.post.delete, () => ownPost),
  (c) => c.json({ ok: true }),
);
