import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { authorizeSql, subjectFromSupabase, supabaseRls } from './index.ts';

describe('subjectFromSupabase', () => {
  it('never throws and fails closed to anonymous', () => {
    expect(() => subjectFromSupabase(null)).not.toThrow();
    expect(subjectFromSupabase(null).principal).toBeNull();
  });

  it('maps tenant and memberships claims and never reads user_metadata', () => {
    const subject = subjectFromSupabase({
      sub: 'user-1',
      role: 'authenticated',
      iss: 'https://proj.supabase.co/auth/v1',
      aal: 'aal2',
      session_id: 'sess-1',
      exp: 1_700_000_000,
      user_role: 'member',
      tenant_id: 'org-1',
      memberships: [{ tenant: 'org-1', roles: ['admin'] }],
      app_metadata: { plan: 'pro' },
      user_metadata: { role: 'superadmin', tenant_id: 'evil' },
    });
    expect(subject.principal?.id).toBe('user-1');
    expect(subject.principal?.roles).toEqual(['member']);
    expect(subject.principal?.tenant).toBe('org-1');
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'org-1', roles: ['admin'] },
    ]);
    expect(subject.principal?.assurance).toEqual({ acr: 'aal2' });
    expect(subject.session).toBe('sess-1');
    expect(subject.principal?.claims).toMatchObject({ plan: 'pro' });
    expect(subject.principal?.claims).not.toHaveProperty('role');
  });

  it('maps resource-scoped memberships from the hook claim', () => {
    const subject = subjectFromSupabase({
      sub: 'user-5',
      role: 'authenticated',
      memberships: [
        { on: { resource: 'document', id: 'd_1' }, roles: ['editor'] },
      ],
    });
    expect(subject.principal?.memberships).toEqual([
      { on: { resource: 'document', id: 'd_1' }, roles: ['editor'] },
    ]);
  });

  it('reads hook claims from app_metadata when top-level is absent', () => {
    const subject = subjectFromSupabase(
      {
        sub: 'user-2',
        role: 'authenticated',
        app_metadata: {
          user_role: ['editor', 'unknown'],
          tenant_id: 'org-2',
        },
      },
      { declared: ['editor'] },
    );
    expect(subject.principal?.roles).toEqual(['editor']);
    expect(subject.principal?.tenant).toBe('org-2');
  });

  it('returns anonymous for missing, anon, and service_role claims', () => {
    expect(subjectFromSupabase(undefined).principal).toBeNull();
    expect(
      subjectFromSupabase({ role: 'anon', sub: 'x' }).principal,
    ).toBeNull();
    expect(
      subjectFromSupabase({ role: 'service_role', sub: 'x' }).principal,
    ).toBeNull();
    expect(subjectFromSupabase({ role: 'authenticated' }).principal).toBeNull();
  });

  it('drops custom claims when the schema fails', () => {
    const subject = subjectFromSupabase(
      {
        sub: 'user-3',
        role: 'authenticated',
        app_metadata: { plan: 1 },
      },
      { schema: z.object({ plan: z.string() }) },
    );
    expect(subject.principal?.id).toBe('user-3');
    expect(subject.principal?.claims).toBeUndefined();
  });

  it('exposes include fields only when asked', () => {
    const subject = subjectFromSupabase(
      {
        sub: 'user-4',
        role: 'authenticated',
        email: 'a@b.c',
        phone: '1',
        is_anonymous: false,
      },
      { include: ['email'] },
    );
    expect(subject.principal?.email).toBe('a@b.c');
    expect(subject.principal?.phone).toBeUndefined();
  });
});

describe('supabaseRls and authorizeSql', () => {
  it('wraps a single memberships table as the tenant mapping', () => {
    const config = supabaseRls({
      memberships: {
        table: 'organization_members',
        tenant: 'organization_id',
        user: 'user_id',
        role: 'role',
      },
    });
    expect(config.dialect).toBe('supabase');
    expect(config.memberships?.tenant?.table).toBe('organization_members');
  });

  it('emits authorize() with an optional tenant parameter', () => {
    const sql = authorizeSql({ tenant: true });
    expect(sql).toContain('requested_tenant uuid default null');
    expect(sql).toContain('security definer');
    expect(sql).not.toMatch(/service_role/);
  });
});
