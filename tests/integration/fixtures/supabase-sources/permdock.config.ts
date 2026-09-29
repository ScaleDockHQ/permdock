import { sources, suspension } from './sources.ts';

export default {
  permissions: '../named-scopes/policy.ts',
  policy: '../named-scopes/policy.ts',
  supabase: {
    hook: {
      memberships: sources(),
      attrs: { table: 'profiles', columns: ['locale', 'timezone'] },
      suspension,
    },
  },
};
