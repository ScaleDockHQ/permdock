import { Hono } from "hono";
import { createClerkSubjectResolver } from "permdock/clerk";
import { createPermDock } from "permdock/hono";

import { ownPost, permissions } from "./permissions.ts";
import { policy } from "./policy.ts";

const authObject = {
  userId: "user_1",
  orgId: "org_1",
  orgRole: "org:member",
  orgPermissions: ["org:invoices:create"],
  sessionClaims: { sub: "user_1", sid: "sess_1", org_id: "org_1" },
  has: () => false,
};

const clerkSubject = createClerkSubjectResolver({
  permissions: { "org:invoices:create": permissions.post.list },
  memberships: "all",
  cache: { ttl: "10s" },
  backend: {
    users: {
      getOrganizationMembershipList: async () => {
        await Promise.resolve();
        return {
          data: [
            { organization: { id: "org_1" }, role: "org:member" },
            { organization: { id: "org_2" }, role: "org:admin" },
          ],
        };
      },
    },
  },
});

const { protect } = createPermDock(policy, {
  subject: async () => {
    const subject = await clerkSubject(authObject);
    return subject;
  },
});

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.patch(
  "/posts/:id",
  protect(permissions.post.update, () => ownPost),
  (c) => {
    const permdock = c.get("permdock");
    return c.json({
      ok: true,
      tenants: permdock.tenants(),
      tenant: permdock.subject.principal?.tenant,
    });
  },
);

app.post(
  "/posts/:id/delete",
  protect(permissions.post.delete, () => ownPost),
  (c) => c.json({ ok: true }),
);
