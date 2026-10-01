import { sources, suspension } from './sources.ts';

export default {
  permissions: './policy.ts',
  policy: './policy.ts',
  rls: {
    dialect: 'supabase',
    authorize: 'database',
    tenantType: 'uuid',
    suspension,
  },
  supabase: {
    hook: {
      memberships: sources(),
      suspension,
      activeFrom: {
        table: 'profiles',
        id: 'user_id',
        column: 'active_organization_id',
      },
    },
  },
};
