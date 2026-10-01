import { sources, suspension } from '../centrakit/sources.ts';

/** CentraKit before adoption: hand-written policies over its own helpers, PermDock writing only the helpers. */
export default {
  permissions: '../centrakit/policy.ts',
  policy: '../centrakit/policy.ts',
  rls: {
    dialect: 'supabase',
    authorize: 'database',
    tenantType: 'uuid',
    suspension,
    helpersOnly: true,
    migrate: {
      helpers: {
        org_ids_with_permission: { form: 'ids', scope: 'organization' },
        has_org_permission: { form: 'row', scope: 'organization' },
        authorize_scope: { form: 'scoped' },
        is_system_user_with: { form: 'global' },
        is_org_member: { form: 'membership', scope: 'organization' },
      },
      keys: {
        'organization.customers.view': 'customers.read',
        'system.organizations.view': 'organizations.read',
      },
      prefixes: { 'organization.': '' },
      globalScopes: ['system'],
    },
  },
  supabase: { hook: { memberships: sources(), suspension } },
};
