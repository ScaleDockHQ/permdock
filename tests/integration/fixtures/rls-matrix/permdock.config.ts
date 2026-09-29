export default {
  permissions: './permissions.ts',
  policy: './policy.ts',
  rls: {
    dialect: 'supabase',
    tenantType: 'text',
    memberships: {
      tenant: {
        table: 'organization_members',
        tenant: 'organization_id',
        user: 'user_id',
        role: 'role',
      },
    },
  },
};
