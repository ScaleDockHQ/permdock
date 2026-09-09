import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import {
  betterAuthRoleSource,
  subjectFromBetterAuth,
} from 'permdock/better-auth';

import { ownPost, permissions } from './permissions.ts';
import { policy } from './policy.ts';

const session = {
  user: { id: 'user-1', role: 'support', email: 'ada@example.com' },
  session: { id: 'sess-1', activeOrganizationId: 'o_acme' },
  members: [{ organizationId: 'o_acme', role: 'member' }],
};

const auth = {
  api: {
    listOrganizationRoles: async () => {
      await Promise.resolve();
      return [
        { role: 'billing-admin', permission: { post: ['read', 'create'] } },
      ];
    },
  },
};

async function dockForSession() {
  const resolved = await subjectFromBetterAuth(auth, session);
  const dock = await createPermDock(policy, resolved, {
    customRoles: betterAuthRoleSource(auth, {
      assignable: [
        { name: 'member', statements: { post: ['read', 'create'] } },
      ],
    }),
  });
  return { dock, resolved };
}

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.patch('/posts/:id', async (c) => {
  const { dock, resolved } = await dockForSession();
  if (!dock.can(permissions.post.update, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true, tenant: resolved.principal?.tenant });
});

app.post('/posts/:id/delete', async (c) => {
  const { dock } = await dockForSession();
  if (!dock.can(permissions.post.delete, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true });
});
