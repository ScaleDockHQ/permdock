import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { subjectFromClerk } from 'permdock/clerk';

import { ownPost, permissions } from './permissions.ts';
import { policy } from './policy.ts';

const authObject = {
  userId: 'user_1',
  orgId: 'org_1',
  orgRole: 'org:member',
  orgPermissions: ['org:invoices:create'],
  sessionClaims: { sub: 'user_1', sid: 'sess_1', org_id: 'org_1' },
  has: () => false,
};

async function dockForSession() {
  const resolved = await subjectFromClerk(authObject, {
    permissions: { 'org:invoices:create': permissions.post.list },
    memberships: 'all',
    backend: {
      users: {
        getOrganizationMembershipList: async () => {
          await Promise.resolve();
          return {
            data: [
              { organization: { id: 'org_1' }, role: 'org:member' },
              { organization: { id: 'org_2' }, role: 'org:admin' },
            ],
          };
        },
      },
    },
  });
  const dock = await createPermDock(policy, resolved);
  return { dock, resolved };
}

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.patch('/posts/:id', async (c) => {
  const { dock, resolved } = await dockForSession();
  if (!dock.can(permissions.post.update, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({
    ok: true,
    tenants: dock.tenants(),
    tenant: resolved.principal?.tenant,
  });
});

app.post('/posts/:id/delete', async (c) => {
  const { dock } = await dockForSession();
  if (!dock.can(permissions.post.delete, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true });
});
