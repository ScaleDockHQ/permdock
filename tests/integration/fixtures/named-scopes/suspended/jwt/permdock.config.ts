export default {
  permissions: '../../policy.ts',
  policy: '../../policy.ts',
  rls: {
    dialect: 'guc',
    tenantType: 'text',
    authorize: 'jwt',
    suspension: {
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
    },
  },
};
