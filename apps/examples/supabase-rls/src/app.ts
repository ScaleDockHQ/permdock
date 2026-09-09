import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import { authorizeSql, subjectFromSupabase } from 'permdock/supabase';

import { ownPost, permissions } from './permissions.ts';
import { policy } from './policy.ts';

const claims = {
  sub: 'u1',
  user_role: 'member',
  tenant_id: 'o1',
  memberships: [{ tenant: 'o1', roles: ['member'] }],
};

async function dockForMember() {
  return  createPermDock(
    policy,
    subjectFromSupabase(claims, {
      roles: 'user_role',
      tenant: 'tenant_id',
      memberships: 'memberships',
      declared: ['member', 'admin'],
    }),
  );
}

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/rls/authorize', (c) => {
  const sql = authorizeSql({ tenant: true });
  if (/service_role/iu.test(sql)) {
    return c.json({ ok: false }, 500);
  }
  return c.json({ ok: true, sql });
});

app.patch('/posts/:id', async (c) => {
  const dock = await dockForMember();
  if (!dock.can(permissions.post.update, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true });
});

app.post('/posts/:id/publish', async (c) => {
  const dock = await dockForMember();
  if (!dock.can(permissions.post.publish, ownPost)) {
    return c.json({ ok: false }, 403);
  }
  return c.json({ ok: true });
});
