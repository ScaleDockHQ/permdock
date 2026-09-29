const suspension = {
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
    dialect: 'guc',
    tenantType: 'text',
    authorize: 'database',
    suspension,
    memberships: {
      scopes: {
        organization: {
          table: 'organization_users',
          user: 'user_id',
          role: 'role',
          columns: { organization: 'organization_id' },
        },
        customer: {
          table: 'customer_contacts',
          user: 'user_id',
          role: 'role',
          columns: {
            customer: 'customer_id',
            organization: 'organization_id',
          },
        },
      },
    },
  },
};
