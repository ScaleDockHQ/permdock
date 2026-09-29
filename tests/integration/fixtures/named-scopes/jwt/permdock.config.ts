export default {
  permissions: '../policy.ts',
  policy: '../policy.ts',
  rls: { dialect: 'guc', tenantType: 'text', authorize: 'jwt' },
};
