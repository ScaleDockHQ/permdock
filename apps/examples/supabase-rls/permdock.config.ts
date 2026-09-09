import { defineConfig } from '@permdock/cli';
import { supabaseRls } from 'permdock/supabase';

export default defineConfig({
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: supabaseRls({
    roleClaim: 'user_role',
    tenantClaim: 'tenant_id',
    memberships: {
      table: 'organization_members',
      tenant: 'organization_id',
      user: 'user_id',
      role: 'role',
    },
  }),
});
