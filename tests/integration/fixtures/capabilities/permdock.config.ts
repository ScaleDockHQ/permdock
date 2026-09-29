export default {
  permissions: './policy.ts',
  policy: './policy.ts',
  rls: {
    dialect: 'supabase',
    tenantType: 'text',
    authorize: 'jwt',
    capabilities: true,
  },
};
