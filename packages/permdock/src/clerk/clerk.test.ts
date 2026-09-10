import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { definePermissions, resource } from '../core/permissions.ts';
import { subjectFromClerk } from './index.ts';

const permissions = definePermissions({
  billing: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['create'],
  }),
});

const authObject = {
  userId: 'user_1',
  orgId: 'org_1',
  orgRole: 'org:admin',
  orgPermissions: ['org:invoices:create', 'org:unknown'],
  sessionId: 'sess_1',
  sessionClaims: {
    sub: 'user_1',
    sid: 'sess_1',
    exp: 1_800_000_000,
    pla: 'o:pro',
    fea: 'o:reporting,u:api_access',
    plan: 'pro',
    unsafeMetadata: { role: 'superadmin' },
  },
  has: () => false,
};

describe('subjectFromClerk', () => {
  it('never throws and fails closed to anonymous', async () => {
    await expect(subjectFromClerk(null)).resolves.toMatchObject({
      principal: null,
    });
    await expect(subjectFromClerk(undefined)).resolves.toMatchObject({
      principal: null,
    });
    await expect(subjectFromClerk({ userId: 'user_x' })).resolves.toMatchObject(
      {
        principal: null,
      },
    );
  });

  it('maps the Clerk auth object to a tenant-scoped subject', async () => {
    const subject = await subjectFromClerk(authObject, {
      permissions: {
        'org:invoices:create': permissions.billing.create,
      },
      features: { reporting: 'reporting', api_access: 'api' },
    });
    expect(subject.principal?.id).toBe('user_1');
    expect(subject.principal?.tenant).toBe('org_1');
    expect(subject.principal?.memberships).toEqual([
      {
        tenant: 'org_1',
        roles: ['org:admin', 'org:invoices:create'],
      },
    ]);
    expect(subject.principal?.clerkPermissions).toEqual([
      'org:invoices:create',
      'org:unknown',
    ]);
    expect(subject.principal?.roles).toEqual(['reporting', 'api']);
    expect(subject.principal?.plans).toEqual(['pro']);
    expect(subject.principal?.featureSources).toEqual({
      reporting: 'o',
      api: 'u',
    });
    expect(subject.session).toBe('sess_1');
    expect(subject.expiresAt).toBe(1_800_000_000);
    expect(subject.principal?.claims).toMatchObject({ plan: 'pro' });
    expect(subject.principal?.claims).not.toHaveProperty('unsafeMetadata');
  });

  it('loads every organization membership through the Backend API', async () => {
    const subject = await subjectFromClerk(authObject, {
      memberships: 'all',
      backend: {
        users: {
          getOrganizationMembershipList: async () => ({
            data: [
              { organization: { id: 'org_1' }, role: 'org:admin' },
              { organization: { id: 'org_2' }, role: 'org:member' },
            ],
          }),
        },
      },
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'org_1', roles: ['org:admin'] },
      { tenant: 'org_2', roles: ['org:member'] },
    ]);
  });

  it('maps a verified session payload and globalRoles from a claim path', async () => {
    const subject = await subjectFromClerk(
      {
        sub: 'user_2',
        sid: 'sess_2',
        org_id: 'org_9',
        org_role: 'org:member',
        publicMetadata: { staff: 'reviewer' },
      },
      { globalRoles: 'publicMetadata.staff' },
    );
    expect(subject.principal?.id).toBe('user_2');
    expect(subject.principal?.tenant).toBe('org_9');
    expect(subject.principal?.roles).toEqual(['reviewer']);
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'org_9', roles: ['org:member'] },
    ]);
  });

  it('returns anonymous when userId is null', async () => {
    const subject = await subjectFromClerk({
      userId: null,
      sessionClaims: { sid: 'sess' },
      has: () => false,
    });
    expect(subject.principal).toBeNull();
  });

  it('drops custom claims when the schema fails', async () => {
    const subject = await subjectFromClerk(authObject, {
      schema: z.object({ plan: z.number() }),
    });
    expect(subject.principal?.id).toBe('user_1');
    expect(subject.principal?.claims).toBeUndefined();
  });

  it('drops undeclared organization roles', async () => {
    const subject = await subjectFromClerk(authObject, {
      declared: ['org:member'],
    });
    expect(subject.principal?.memberships).toEqual([]);
  });

  it('treats a thrown Backend API call as no extra memberships', async () => {
    const subject = await subjectFromClerk(authObject, {
      memberships: 'all',
      backend: {
        users: {
          getOrganizationMembershipList: async () => {
            throw new Error('down');
          },
        },
      },
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'org_1', roles: ['org:admin'] },
    ]);
  });
});
