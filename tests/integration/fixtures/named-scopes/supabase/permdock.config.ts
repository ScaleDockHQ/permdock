import type { SupabaseSuspension } from 'permdock/supabase';

import { fromJunction } from 'permdock/supabase';

const suspension: SupabaseSuspension = {
  users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' },
  scopes: {
    organization: {
      table: 'organization',
      id: 'id',
      disabledAt: 'disabled_at',
    },
    customer: {
      table: 'customer',
      id: 'id',
      status: 'status',
      active: ['active', 'prospect'],
    },
  },
};

export default {
  permissions: '../policy.ts',
  policy: '../policy.ts',
  rls: {
    dialect: 'supabase',
    tenantType: 'text',
    authorize: 'jwt',
    suspension,
    memberships: {
      scopes: {
        organization: {
          table: 'organization_users',
          user: 'user_id',
          role: 'role',
          via: 'via',
          columns: { organization: 'organization_id' },
        },
        customer: {
          table: 'customer_contacts',
          user: 'user_id',
          role: 'role',
          via: 'via',
          columns: {
            customer: 'customer_id',
            organization: 'organization_id',
          },
          expiresAt: 'expires_at',
        },
      },
    },
  },
  supabase: {
    hook: {
      memberships: [
        fromJunction({
          table: 'organization_users',
          scope: 'organization',
          id: 'organization_id',
          roles: 'role',
          via: 'staff',
          suspension,
        }),
        fromJunction({
          table: 'customer_contacts',
          scope: 'customer',
          id: 'customer_id',
          within: { organization: 'organization_id' },
          roles: 'role',
          via: 'contact',
          expiresAt: 'expires_at',
          suspension,
        }),
      ],
    },
  },
};
